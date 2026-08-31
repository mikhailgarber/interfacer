import { startAll, type FixtureBundle } from '@interfacer/fixtures';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApprovalDenied,
  CheckpointFailed,
  InteractionFailed,
  isReplayError,
  isSuspended,
  makeSecret,
  parkedCount,
  PauseExpired,
  resume,
  runFlow,
  UnknownSession,
  type Entry,
  type InteractionRequest,
  type InteractionResponse,
  type ReplayError,
  type Resolver,
  type Suspended,
} from '@interfacer/dsl';

import {
  approvedTransferFlow,
  attendedBalanceFlow,
  MFA_PROMPT,
  neverArrivesFlow,
  OPERATOR_REASON,
  staleCheckpointFlow,
  staleSurfaceWaitFlow,
  type AttendedInput,
  type TransferInput,
} from './flows.js';

/**
 * Pause and resume, against a real browser and a real fixture.
 *
 * Every test here authors a `Flow` and calls the engine — never `page.click()`.
 * What is under test is the suspension machinery: that a bound is honoured, that
 * an answer is validated against the kind that was asked, that a run with
 * nowhere to ask parks rather than hanging, and that resume re-asserts a
 * checkpoint instead of driving blind into whatever is on screen.
 *
 * The resolvers here are fakes, not mocks. Each is a real function that answers
 * the way a CLI's keyboard reader or a host's policy would, and the assertions
 * are about what the run produced — never about how many times a resolver was
 * called.
 */

const SENTINEL = 's3cret-teller';

let bundle: FixtureBundle;
let browser: Browser;

beforeAll(async () => {
  [bundle, browser] = await Promise.all([startAll(), chromium.launch()]);
}, 60_000);

afterAll(async () => {
  await Promise.all([bundle.closeAll(), browser.close()]);
});

function attended(): AttendedInput {
  return {
    url: bundle.fixtures.clean.url,
    username: 'teller1',
    password: makeSecret(SENTINEL),
  };
}

function transfer(): TransferInput {
  return {
    url: bundle.fixtures.clean.url,
    username: 'teller1',
    password: makeSecret(SENTINEL),
    fromRef: 'ACC-1001',
    toRef: 'ACC-1002',
    amount: '25.00',
  };
}

interface Captured {
  readonly entries: Entry[];
  readonly record: (entry: Entry) => void;
}

function capture(): Captured {
  const entries: Entry[] = [];
  return {
    entries,
    record: (entry) => {
      entries.push(entry);
    },
  };
}

const RUN = { timeoutMs: 1_500, retries: 1, record: (): void => undefined } as const;

async function rejection(run: Promise<unknown>): Promise<ReplayError> {
  try {
    await run;
  } catch (error) {
    if (isReplayError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the run to fail, but it returned');
}

/** The resolver a CLI would install: answer each kind the way it was asked. */
function answering(overrides: Partial<Record<string, InteractionResponse>> = {}): Resolver {
  return (request: InteractionRequest) => {
    const override = overrides[request.name];
    if (override !== undefined) {
      return Promise.resolve(override);
    }

    switch (request.kind) {
      case 'input':
        return Promise.resolve(makeSecret('ACC-1001'));
      case 'approval':
        return Promise.resolve(true);
      case 'operator':
        return Promise.resolve('done' as const);
    }
  };
}

/** A resolver nobody is behind. Makes the bound the thing that ends the pause. */
const silent: Resolver = () => new Promise<never>(() => undefined);

function suspension(result: unknown): Suspended {
  if (!isSuspended(result)) {
    throw new Error(`expected the run to park, got ${JSON.stringify(result)}`);
  }
  return result;
}

// @covers pause.four-kinds pause.declared-is-not-an-escalation
describe('a resolver answers, and the run completes', () => {
  it('carries a flow through a surface wait, a handover and a value it was given', async () => {
    // Three kinds in one run. They are the same primitive differing only in the
    // resolver, and a flow that mixes them is what makes that checkable.
    const captured = capture();

    const answer = await runFlow(attendedBalanceFlow(), attended(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: answering(),
    });

    expect(answer).toEqual({ status: 'ok', balance: 1250.75 });

    const pauses = captured.entries.filter((entry) => entry.kind === 'pause');
    expect(pauses.map((entry) => entry.reason)).toEqual([
      'awaiting-surface',
      'awaiting-action',
      'awaiting-input',
    ]);
    // A pause named in the flow is part of the contract, not an incident.
    expect(pauses.every((entry) => entry.declared)).toBe(true);
    expect(pauses.every((entry) => entry.expiresAt.length > 0)).toBe(true);
  });

  it('publishes the prompt it was authored with, and never the value it got back', async () => {
    const prompts: string[] = [];
    const captured = capture();

    await runFlow(attendedBalanceFlow(), attended(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: (request) => {
        prompts.push(request.prompt);
        return answering()(request);
      },
    });

    expect(prompts).toEqual([OPERATOR_REASON, MFA_PROMPT]);

    // The value arrives as a `Secret`, so the pause that asked for it records
    // the prompt and the bound and never the answer. (The page's own URL is a
    // different question: this application puts the reference in a query string,
    // and masking observed page content is what `dataClasses` is for.)
    const asked = captured.entries.filter((entry) => entry.stepId === 'search.askRef');
    expect(asked.length).toBeGreaterThan(0);
    expect(JSON.stringify(asked)).not.toContain('ACC-1001');
  });

  it('takes an approval before the point of no return', async () => {
    const captured = capture();

    const answer = await runFlow(approvedTransferFlow(), transfer(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: answering(),
    });

    expect(answer).toEqual({ status: 'ok', reference: 'TRF-000417' });

    const order = captured.entries
      .filter((entry) => entry.kind === 'pause' || entry.stepId === 'transfer.commit')
      .map((entry) => entry.kind);
    // The approval is recorded before the commit ever starts. An approval that
    // followed the commit would approve nothing.
    expect(order[0]).toBe('pause');
  });

  // @covers record.control-transfer-is-evidence
  it('says who held control, for how long, and what the page was either side', async () => {
    const captured = capture();

    await runFlow(attendedBalanceFlow(), attended(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: answering(),
    });

    const transferred = captured.entries.filter((entry) => entry.kind === 'control.transferred');
    const returned = captured.entries.filter((entry) => entry.kind === 'control.returned');

    expect(transferred.map((entry) => entry.holder)).toEqual(['resolver', 'resolver']);
    expect(returned.map((entry) => entry.holder)).toEqual(['resolver', 'resolver']);
    expect(transferred.every((entry) => entry.stateBefore.startsWith('http'))).toBe(true);
    expect(returned.every((entry) => entry.stateAfter.startsWith('http'))).toBe(true);
    expect(returned.every((entry) => entry.heldMs >= 0)).toBe(true);
  });
});

// @covers pause.four-kinds pause.response-validated-against-kind
describe('an answer of the wrong kind', () => {
  it('is a hard failure rather than a guess about what was meant', async () => {
    // One resolver serves every kind, so the response type cannot be tied to the
    // request kind at compile time. This is the runtime check that buys it back.
    const error = await rejection(
      runFlow(attendedBalanceFlow(), attended(), {
        ...RUN,
        browser,
        resolver: answering({ accountRef: true }),
      }),
    );

    expect(error).toBeInstanceOf(InteractionFailed);
    expect(error.step).toBe('search.askRef');
    expect(error.expected).toBe('a Secret<string>');
    expect(error.observed).toBe('the boolean true');
  });

  it('treats a resolver that throws as a failure to answer, not as a deny', async () => {
    // A thrown resolver is a bug in the caller's policy. Reading it as a refusal
    // would silently pick one of the two answers it failed to give — and on an
    // approval, picking either is the guess this design exists to prevent.
    const error = await rejection(
      runFlow(approvedTransferFlow(), transfer(), {
        ...RUN,
        browser,
        resolver: () => Promise.reject(new Error('no policy for this capability')),
      }),
    );

    expect(error).toBeInstanceOf(InteractionFailed);
    expect(error.step).toBe('transfer.approve');
    expect(error.observed).toBe('no policy for this capability');
  });

  it('will not read an approval out of a string', async () => {
    const error = await rejection(
      runFlow(approvedTransferFlow(), transfer(), {
        ...RUN,
        browser,
        resolver: answering({ 'transfer.approve': 'done' }),
      }),
    );

    expect(error).toBeInstanceOf(InteractionFailed);
    expect(error.step).toBe('transfer.approve');
  });
});

// @covers pause.every-pause-bounded
describe('a pause nobody answers', () => {
  it('ends an input pause at its bound, with evidence', async () => {
    const captured = capture();

    const error = await rejection(
      runFlow(attendedBalanceFlow({ within: '400ms' }), attended(), {
        ...RUN,
        browser,
        record: captured.record,
        resolver: silent,
      }),
    );

    expect(error).toBeInstanceOf(PauseExpired);
    // The operator pause is the first one a human is asked, so it is the one
    // that expires.
    expect(error.step).toBe('search.handover');

    const errors = captured.entries.filter((entry) => entry.kind === 'error');
    expect(errors.at(-1)?.observed).toContain('nobody answered');
    expect(captured.entries.at(-1)).toMatchObject({
      kind: 'run.finished',
      status: { ending: 'failure', category: 'hard-failure' },
    });
  });

  it('treats an expired approval as a deny, because silence is not consent', async () => {
    const captured = capture();

    const error = await rejection(
      runFlow(approvedTransferFlow({ within: '400ms' }), transfer(), {
        ...RUN,
        browser,
        record: captured.record,
        resolver: silent,
      }),
    );

    expect(error).toBeInstanceOf(ApprovalDenied);
    expect(error.step).toBe('transfer.approve');
    // The point of no return was never reached.
    expect(captured.entries.some((entry) => entry.stepId === 'transfer.commit')).toBe(false);
  });

  it('treats a refusal the same way it treats silence', async () => {
    const captured = capture();

    const error = await rejection(
      runFlow(approvedTransferFlow(), transfer(), {
        ...RUN,
        browser,
        record: captured.record,
        resolver: answering({ 'transfer.approve': false }),
      }),
    );

    expect(error).toBeInstanceOf(ApprovalDenied);
    expect(error.observed).toBe('the approver refused');
    expect(captured.entries.some((entry) => entry.stepId === 'transfer.commit')).toBe(false);
  });

  it('fails a surface that never arrives, after retrying the wait', async () => {
    // "Loaded slowly" and "never loaded" stay distinguishable: this one is
    // never, and it says so at the bound rather than hanging.
    const captured = capture();

    const error = await rejection(
      runFlow(neverArrivesFlow({ within: '300ms' }), attended(), {
        ...RUN,
        browser,
        record: captured.record,
      }),
    );

    expect(error).toBeInstanceOf(CheckpointFailed);
    expect(error.step).toBe('never.arrive');
    // A surface wait is retryable, so it goes round the ladder once before the
    // hard failure — unlike a human pause, which is a verdict the first time.
    expect(captured.entries.filter((entry) => entry.kind === 'retry')).toHaveLength(1);
  });
});

// @covers execution.waiting-is-never-a-sleep
describe('waiting is never a sleep', () => {
  it('returns as soon as the predicate holds, not when the bound elapses', async () => {
    // A sleep would take the whole bound. A predicate returns the moment it is
    // true, which is the entire difference between `.wait(30000)` and
    // `.pauseUntil(target, { within: '30s' })`.
    const captured = capture();
    const startedAt = Date.now();

    await runFlow(attendedBalanceFlow({ within: '20s' }), attended(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: answering(),
    });

    expect(Date.now() - startedAt).toBeLessThan(20_000);

    const resumed = captured.entries.find(
      (entry) => entry.kind === 'resume' && entry.reason === 'awaiting-surface',
    );
    expect(resumed).toMatchObject({ resolvedBy: 'polling' });
    expect(resumed?.kind === 'resume' && resumed.waitedMs < 5_000).toBe(true);
  });
});

// @covers project.resolver-removes-the-suspended-arm
describe('a run with nowhere to ask', () => {
  it('parks, hands back the request, and continues when resumed', async () => {
    // A run parks only where there is nowhere to ask. The caller gets a control
    // state, not a business outcome — which is why it is a `suspended` arm the
    // resolver overload does not have.
    const captured = capture();

    const parked = suspension(
      await runFlow(attendedBalanceFlow(), attended(), {
        ...RUN,
        browser,
        record: captured.record,
      }),
    );

    expect(parked.request).toMatchObject({
      kind: 'operator',
      name: 'search.handover',
      prompt: OPERATOR_REASON,
      secret: false,
    });
    expect(parkedCount()).toBe(1);

    const asked = suspension(await resume(parked.sessionId, 'done'));
    expect(asked.request).toMatchObject({ kind: 'input', name: 'accountRef', secret: true });

    const answer = await resume(asked.sessionId, makeSecret('ACC-1001'));
    expect(answer).toEqual({ status: 'ok', balance: 1250.75 });
    expect(parkedCount()).toBe(0);

    // Parking is not a different way of running: the record is one record.
    expect(captured.entries.filter((entry) => entry.kind === 'pause')).toHaveLength(3);
    expect(
      captured.entries
        .filter((entry) => entry.kind === 'control.transferred')
        .map((entry) => entry.holder),
    ).toEqual(['caller', 'caller']);
  });

  // @covers parked.single-shot-resume
  it('refuses a second resume on the same id', async () => {
    const parked = suspension(
      await runFlow(attendedBalanceFlow(), attended(), { ...RUN, browser }),
    );

    // Run it to the end, so this test leaves no browser parked behind it — the
    // same leak the TTL exists to catch in production.
    const asked = suspension(await resume(parked.sessionId, 'done'));
    await resume(asked.sessionId, makeSecret('ACC-1001'));

    await expect(resume(parked.sessionId, 'done')).rejects.toBeInstanceOf(UnknownSession);
    expect(parkedCount()).toBe(0);
  });

  it('refuses an id it never issued', async () => {
    await expect(resume('sess_nothing', 'done')).rejects.toBeInstanceOf(UnknownSession);
  });
});

// @covers pause.resume-reasserts-a-checkpoint
describe('resume re-asserts a checkpoint', () => {
  it('confirms the session came back where it was left', async () => {
    const captured = capture();

    await runFlow(attendedBalanceFlow(), attended(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: answering(),
    });

    // `search.reached` is asserted once when the flow reaches it, and again
    // after each of the two human pauses.
    const reassertions = captured.entries.filter(
      (entry) => entry.kind === 'checkpoint' && entry.stepId === 'search.reached',
    );
    expect(reassertions).toHaveLength(3);
    expect(reassertions.every((entry) => entry.kind === 'checkpoint' && entry.satisfied)).toBe(
      true,
    );
  });

  it('is a hard failure when the page is no longer the one the flow paused on', async () => {
    // Not a blind continuation. After a human touches the session the flow
    // cannot assume where it is, and here it genuinely is not: the flow moved on
    // to the account screen after `search.reached` last held.
    const captured = capture();

    const error = await rejection(
      runFlow(
        staleCheckpointFlow(),
        { ...attended(), accountRef: 'ACC-1001' },
        { ...RUN, browser, record: captured.record, resolver: answering() },
      ),
    );

    expect(error).toBeInstanceOf(CheckpointFailed);
    expect(error.step).toBe('balance.approve');
    expect(error.expected).toContain('search.reached');
    expect(captured.entries.some((entry) => entry.kind === 'checkpoint' && !entry.satisfied)).toBe(
      true,
    );
  });

  it('does not re-assert after a surface wait, because nobody touched the session', async () => {
    // The same position as the failing flow above, waiting on a surface instead
    // of asking a human — and it completes. Polling is not a human, and
    // re-asserting after it would make every flow that waits for a *new* screen
    // fail on the old one.
    const answer = await runFlow(
      staleSurfaceWaitFlow(),
      { ...attended(), accountRef: 'ACC-1001' },
      { ...RUN, browser, resolver: answering() },
    );

    expect(answer).toEqual({ status: 'ok' });
  });
});

// @covers parked.ttl-kills-the-browser
describe('a parked run that nobody comes back for', () => {
  it('kills the live session at its TTL and marks the run a hard failure', async () => {
    // A forgotten session must not strand a browser process. This run is given
    // its own browser so the kill is observable: the engine closes the context
    // it opened, and — by the standing ownership rule — a browser it opened
    // itself, which is the case a caller who supplies none gets.
    const own = await chromium.launch();
    const captured = capture();

    try {
      const parked = suspension(
        await runFlow(attendedBalanceFlow(), attended(), {
          ...RUN,
          browser: own,
          record: captured.record,
          ttlMs: 250,
        }),
      );

      // Nobody is holding the run's promise once it has parked, so the record is
      // where the failure lands. That is the point of the evidence being one
      // append-only log rather than a return value.
      await until(() => captured.entries.some((entry) => entry.kind === 'run.finished'));

      expect(own.contexts()).toHaveLength(0);

      const failure = captured.entries.filter((entry) => entry.kind === 'error').at(-1);
      expect(failure?.observed).toContain('TTL');
      expect(captured.entries.at(-1)).toMatchObject({
        kind: 'run.finished',
        status: { ending: 'failure', category: 'hard-failure' },
      });

      // The id died with the session, so a late resume finds nothing to resume.
      await expect(resume(parked.sessionId, 'done')).rejects.toBeInstanceOf(UnknownSession);
    } finally {
      await own.close();
    }
  }, 20_000);
});

/** Poll until a condition holds, or give up. Bounded, so a test cannot hang. */
async function until(condition: () => boolean, withinMs = 5_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition did not hold within the bound');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
