import { startAll, type FixtureBundle, type FixtureName } from '@interfacer/fixtures';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  byLabel,
  byRole,
  byText,
  css,
  field,
  fields,
  Flow,
  InputMissing,
  isReplayError,
  makeSecret,
  NavigationBlocked,
  runFlow,
  secret,
  TargetAmbiguous,
  text,
  type Entry,
  type ReplayError,
} from '@interfacer/dsl';

import {
  ACCOUNT_REF_FIELD,
  BALANCE,
  balanceFlow,
  balanceInput,
  hostileLogin,
  LOOK_UP,
  ON_SEARCH_SCREEN,
  PASSWORD_FIELD,
  SIGN_IN,
  transferFlow,
  USERNAME_FIELD,
  type BalanceInput,
} from './flows.js';

/**
 * The production path, proved.
 *
 * Real browser, real fixture, no model. Every test here authors a `Flow` and
 * calls the engine — never `page.click()` — because what is under test is the
 * step cycle: resolution through the chain, the verification order, retry
 * gating, allowlist enforcement and record emission.
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

function url(name: FixtureName): string {
  return bundle.fixtures[name].url;
}

function input(name: FixtureName, accountRef = 'ACC-1001', username = 'teller1'): BalanceInput {
  return {
    url: url(name),
    username,
    password: makeSecret(username === 'teller1' ? SENTINEL : 's3cret-viewer'),
    accountRef,
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

/**
 * Discard the record unless a test asks for it.
 *
 * The default destination is stdout, which is right for a capability being run
 * from a shell and wrong for a test run — it would bury the reporter's output.
 * The default itself is covered explicitly below rather than incidentally here.
 */
const RUN = { timeoutMs: 1_500, retries: 1, record: (): void => undefined } as const;

/**
 * Await a run that must fail, and hand back the typed error.
 *
 * Asserting on the properties directly rather than through asymmetric matchers:
 * `expect.stringContaining` is typed `any`, which would quietly let a renamed
 * field pass.
 */
// @covers errors.guard-is-exported
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

// @covers execution.deterministic-replay execution.step-cycle
describe('determinism', () => {
  it('produces the same steps, the same resolutions and the same result every run', async () => {
    // Determinism is a claim about the decision procedure, not about the world.
    // The fixture's data is fixed so that this can be a claim about the engine.
    const runs = await Promise.all(
      [0, 1, 2].map(async () => {
        const captured = capture();
        const answer = await runFlow(balanceFlow(), input('clean'), {
          ...RUN,
          browser,
          record: captured.record,
        });
        return { answer, entries: captured.entries };
      }),
    );

    const shape = (entries: Entry[]): unknown =>
      entries
        .filter((entry) => entry.kind === 'step.finished')
        .map((entry) => ({
          step: entry.stepId,
          by: 'resolvedBy' in entry ? entry.resolvedBy : undefined,
          index: 'strategyIndex' in entry ? entry.strategyIndex : undefined,
        }));

    expect(runs[0]?.answer).toEqual({ status: 'ok', balance: 1250.75 });
    expect(runs[1]?.answer).toEqual(runs[0]?.answer);
    expect(runs[2]?.answer).toEqual(runs[0]?.answer);
    expect(shape(runs[1]?.entries ?? [])).toEqual(shape(runs[0]?.entries ?? []));
    expect(shape(runs[2]?.entries ?? [])).toEqual(shape(runs[0]?.entries ?? []));
  });
});

// @covers position.outcomes-are-contract errors.business-outcome-returned execution.outcomes-before-failure dsl.outcome-terminates execution.three-endings
describe('verification order', () => {
  it.each([
    [
      'a missing record',
      'ACC-9999',
      'teller1',
      { status: 'account_not_found', accountRef: 'ACC-9999' },
    ],
    [
      'an insufficient role',
      'ACC-2002',
      'viewer1',
      { status: 'permission_denied', requiredRole: 'TELLER' },
    ],
  ])('returns %s rather than throwing it', async (_label, ref, username, expected) => {
    // The run succeeded: it found out something true. A caller that handles
    // every arm of the union has handled every answer the capability can give.
    const answer = await runFlow(balanceFlow(), input('clean', ref, username), {
      ...RUN,
      browser,
    });

    expect(answer).toEqual(expected);
  });

  it('makes the same page state a hard failure once the detector is removed', async () => {
    // The other half of the pair. Without it, the test above would pass on a
    // flow that simply never failed — this is what proves the *ordering* rather
    // than assuming it.
    await expect(
      runFlow(balanceFlow({ withOutcomes: false }), input('clean', 'ACC-9999'), {
        ...RUN,
        browser,
      }),
    ).rejects.toSatisfy(isReplayError);
  });

  it('records which declared detector fired', async () => {
    const captured = capture();
    await runFlow(balanceFlow(), input('clean', 'ACC-9999'), {
      ...RUN,
      browser,
      record: captured.record,
    });

    const matched = captured.entries.find((entry) => entry.kind === 'outcome.matched');
    expect(matched).toMatchObject({ detectorIndex: 0, status: 'outcome.notFound' });
  });

  it('ends the run at the matched outcome, executing nothing after it', async () => {
    const captured = capture();
    await runFlow(balanceFlow(), input('clean', 'ACC-9999'), {
      ...RUN,
      browser,
      record: captured.record,
    });

    const started = captured.entries
      .filter((entry) => entry.kind === 'step.started')
      .map((entry) => entry.stepId);

    expect(started).toContain('search.submit');
    expect(started).not.toContain('balance.read');
  });
});

// @covers tenant.branding-is-absorbed tenant.wording-is-absorbed target.fallback-is-drift target.unique-match-required
describe('targeting', () => {
  it('replays the same flow unchanged against a rebranded tenant', async () => {
    // A flow whose targets lead with `role` and `label` is branding-invariant by
    // construction. This is the same flow object shape, the same target chains,
    // pointed at a differently styled and differently worded application.
    const answer = await runFlow(balanceFlow(), input('rebranded'), { ...RUN, browser });

    expect(answer).toEqual({ status: 'ok', balance: 1250.75 });
  });

  it('returns a declared outcome on a rebranded tenant, through the alternative wording', async () => {
    // `rebranded` says "Account not found" where `clean` says "No such
    // account". The detector chain admits both, so the business outcome does not
    // quietly degrade into a hard failure.
    const answer = await runFlow(balanceFlow(), input('rebranded', 'ACC-9999'), {
      ...RUN,
      browser,
    });

    expect(answer).toEqual({ status: 'account_not_found', accountRef: 'ACC-9999' });
  });

  it('lets a fallback carry a step, and records that as drift', async () => {
    // `legacy` associates no label with any field, so the semantic strategy
    // fails and the recorded selector carries it. The artifact survived by
    // luck, and the record says so rather than passing silently.
    const captured = capture();
    const answer = await runFlow(balanceFlow(), input('legacy'), {
      ...RUN,
      browser,
      record: captured.record,
    });

    expect(answer).toEqual({ status: 'ok', balance: 1250.75 });

    const drifted = captured.entries
      .filter((entry) => entry.kind === 'step.finished' && entry.drifted)
      .map((entry) => entry.stepId);

    expect(drifted).toContain('login.username');
    expect(drifted).toContain('login.password');
  });

  it('reports no drift where the primary strategy carried every step', async () => {
    const captured = capture();
    await runFlow(balanceFlow(), input('clean'), { ...RUN, browser, record: captured.record });

    const drifted = captured.entries.filter(
      (entry) => entry.kind === 'step.finished' && entry.drifted,
    );

    expect(drifted).toEqual([]);
  });

  it('fails hard on an ambiguous target rather than taking the first match', async () => {
    // `hostile` labels two different fields "ID". Two elements answering to the
    // same description means the recorded intent is no longer unambiguous, and
    // acting on either is a guess.
    const flow = hostileLogin(new Flow({ id: 'ambiguous', input: balanceInput }))
      .fillForm([byLabel('ID')], (i) => i.accountRef, { id: 'search.ambiguous' })
      .returns(() => ({ status: 'ok' as const }));

    await expect(runFlow(flow, input('hostile'), { ...RUN, browser })).rejects.toThrow(
      TargetAmbiguous,
    );
  });

  it('names the step and both sides of an ambiguous match', async () => {
    const flow = hostileLogin(new Flow({ id: 'ambiguous', input: balanceInput }))
      .fillForm([byLabel('ID')], (i) => i.accountRef, { id: 'search.ambiguous' })
      .returns(() => ({ status: 'ok' as const }));

    const error = await rejection(runFlow(flow, input('hostile'), { ...RUN, browser }));

    expect(error.step).toBe('search.ambiguous');
    expect(error.expected).toContain('exactly one element');
    expect(error.observed).toContain('2 elements');
  });
});

// @covers execution.retry-gated-per-step dsl.commit-never-retried errors.recoverable-is-evidence-only
describe('retry gating', () => {
  it('retries an ordinary press, which commits nothing', async () => {
    const captured = capture();
    const flow = new Flow({ id: 'retries', input: balanceInput })
      .open((i) => i.url, { id: 'login.open' })
      .pressButton([css('#not-on-this-page')], { id: 'ghost' })
      .returns(() => ({ status: 'ok' as const }));

    await expect(
      runFlow(flow, input('clean'), { ...RUN, browser, record: captured.record }),
    ).rejects.toSatisfy(isReplayError);

    expect(captured.entries.filter((entry) => entry.kind === 'retry')).toHaveLength(1);
  });

  it('never retries a commit', async () => {
    // A timed-out commit may already have gone through, and repeating it is
    // worse than failing. Gating is per step, not per capability — the same run
    // retries everything else.
    const captured = capture();
    const flow = new Flow({ id: 'commits', input: balanceInput })
      .open((i) => i.url, { id: 'login.open' })
      .commit([css('#not-on-this-page')], { id: 'ghost' })
      .returns(() => ({ status: 'ok' as const }));

    await expect(
      runFlow(flow, input('clean'), { ...RUN, browser, record: captured.record }),
    ).rejects.toSatisfy(isReplayError);

    expect(captured.entries.filter((entry) => entry.kind === 'retry')).toEqual([]);
  });

  it('drives a mutating capability through its point of no return', async () => {
    const answer = await runFlow(
      transferFlow(),
      {
        url: url('clean'),
        username: 'teller1',
        password: makeSecret(SENTINEL),
        fromRef: 'ACC-1001',
        toRef: 'ACC-1002',
        amount: '25.00',
      },
      { ...RUN, browser },
    );

    expect(answer).toEqual({ status: 'ok', reference: 'TRF-000417' });
  });
});

describe('a step whose input was never supplied', () => {
  it('fails as a typed error naming the input, not as a crash inside the engine', async () => {
    // Discovery fills this map as the model asks for values, so a step can
    // genuinely reach a field that has none yet — and what came back was
    // `TypeError: Cannot read properties of undefined (reading 'reveal')`,
    // which is not a failure a caller can act on and not one the agent loop can
    // relay as information. `field()` is what makes the better message
    // possible: an accessor that carries what it reads can say what is missing.
    const flow = new Flow({ id: 'unsupplied', input: balanceInput })
      .open(field('url'), { id: 'login.open' })
      .fillForm(USERNAME_FIELD, field('username'), { id: 'login.username' })
      .returns(() => ({ status: 'ok' as const }));

    const missing = { url: url('clean'), password: makeSecret(SENTINEL), accountRef: 'ACC-1001' };
    const error = await rejection(
      runFlow(flow, missing as unknown as BalanceInput, { ...RUN, browser }),
    );

    expect(error).toBeInstanceOf(InputMissing);
    expect(error.step).toBe('login.username');
    // The input by name, not the target chain: `label="Username"` would satisfy
    // a looser assertion while saying nothing about what is actually missing.
    expect(error.expected).toContain('a value for input "username"');
  });

  it('says what it can where the accessor is a closure that cannot describe itself', async () => {
    // A plain `i => i.username` stays a legal accessor and always will; it
    // simply cannot say which input it read, so the message says that much
    // rather than naming the wrong thing.
    const flow = new Flow({ id: 'unsupplied', input: balanceInput })
      .open((i) => i.url, { id: 'login.open' })
      .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
      .returns(() => ({ status: 'ok' as const }));

    const missing = { url: url('clean'), password: makeSecret(SENTINEL), accountRef: 'ACC-1001' };
    const error = await rejection(
      runFlow(flow, missing as unknown as BalanceInput, { ...RUN, browser }),
    );

    expect(error).toBeInstanceOf(InputMissing);
    expect(error.observed).toContain('nothing');
  });
});

// @covers allowlist.judged-on-resolved-url allowlist.enforced-inside-the-dsl allowlist.leaving-it-is-a-hard-failure tenant.entry-point-is-an-input
describe('the allowlist', () => {
  it('admits the entry point the caller chose', async () => {
    // The entry point is an ordinary input: one artifact serves every tenant
    // differing only by host, so the list is not there to second-guess where the
    // caller pointed the capability.
    const captured = capture();
    await runFlow(balanceFlow(), input('clean'), { ...RUN, browser, record: captured.record });

    const navigations = captured.entries.filter((entry) => entry.kind === 'navigation');
    expect(navigations.length).toBeGreaterThan(0);
    expect(navigations.every((entry) => entry.allowed)).toBe(true);
  });

  it('fails hard when a redirect resolves off-list', async () => {
    // The check applies to the resolved URL after redirects, because an allowed
    // host can redirect off-list — and the browser follows that hop without the
    // engine's request interception seeing it.
    const flow = new Flow({ id: 'offsite', input: fields({ url: text() }) })
      .open((i) => `${i.url}/offsite`, { id: 'leave' })
      .checkpoint([byText('Offsite')], { id: 'landed' })
      .returns(() => ({ status: 'ok' as const }));

    await expect(runFlow(flow, { url: url('clean') }, { ...RUN, browser })).rejects.toThrow(
      NavigationBlocked,
    );
  });

  it('records the off-list navigation with the host it reached', async () => {
    const captured = capture();
    const flow = new Flow({ id: 'offsite', input: fields({ url: text() }) })
      .open((i) => `${i.url}/offsite`, { id: 'leave' })
      .returns(() => ({ status: 'ok' as const }));

    const error = await rejection(
      runFlow(flow, { url: url('clean') }, { ...RUN, browser, record: captured.record }),
    );

    expect(error.observed).toContain('localhost');

    const denied = captured.entries.find((entry) => entry.kind === 'navigation' && !entry.allowed);
    expect(denied).toMatchObject({ allowed: false, reason: 'host-not-allowed' });
  });
});

// @covers secrets.never-reach-the-record secrets.revealed-only-in-a-primitive record.inputs-by-name-only
describe('redaction', () => {
  it('keeps the secret out of every entry in the record', async () => {
    // Asserted as a property rather than an example: the whole record is
    // scanned for the sentinel, not one field checked. A secret reaches the page
    // only through an explicit `.reveal()` inside a DSL primitive.
    const captured = capture();
    await runFlow(balanceFlow(), input('clean'), { ...RUN, browser, record: captured.record });

    const everything = captured.entries.map((entry) => JSON.stringify(entry)).join('\n');

    expect(everything).not.toContain(SENTINEL);
    expect(everything.length).toBeGreaterThan(0);
  });

  it('keeps the secret out of a thrown error, however the run failed', async () => {
    const captured = capture();

    await expect(
      runFlow(balanceFlow({ withOutcomes: false }), input('clean', 'ACC-9999'), {
        ...RUN,
        browser,
        record: captured.record,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const rendered = JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        ...(isReplayError(error) ? { expected: error.expected, observed: error.observed } : {}),
      });
      return !rendered.includes(SENTINEL);
    });

    expect(captured.entries.map((entry) => JSON.stringify(entry)).join('\n')).not.toContain(
      SENTINEL,
    );
  });

  it('records that a secret input was supplied, by name', async () => {
    const captured = capture();
    await runFlow(balanceFlow(), input('clean'), { ...RUN, browser, record: captured.record });

    // Names, never values. Structural, not filtered: there is no field on this
    // entry that a value could be put in.
    expect(captured.entries[0]).toMatchObject({
      kind: 'run.started',
      secretInputNames: ['password'],
    });
  });
});

// @covers record.one-append-only-log record.common-envelope record.stdout-by-default record.author-writes-no-log-line errors.hard-failure-is-typed
describe('the run record', () => {
  it('goes to stdout as one JSON object per line by default', async () => {
    // The record is a log, and is configured like one: a run is pipeable and
    // needs no path convention at all. Phase 5 adds the other destinations —
    // including the one that is not a preference but a constraint, since an MCP
    // server's stdout is the protocol transport.
    const written: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string): boolean => {
      written.push(chunk);
      return true;
    };

    try {
      await runFlow(balanceFlow(), input('clean'), { timeoutMs: 1_500, retries: 1, browser });
    } finally {
      process.stdout.write = stdout;
    }

    const lines = written.join('').split('\n').filter(Boolean);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ kind: 'run.started' });
  });

  it('brackets the run and every step', async () => {
    const captured = capture();
    await runFlow(balanceFlow(), input('clean'), { ...RUN, browser, record: captured.record });

    const kinds = captured.entries.map((entry) => entry.kind);

    expect(kinds[0]).toBe('run.started');
    expect(kinds.at(-1)).toBe('run.finished');
    expect(captured.entries.at(-1)).toMatchObject({ status: { ending: 'success' } });
  });

  it('numbers entries so they can reference one another', async () => {
    const captured = capture();
    await runFlow(balanceFlow(), input('clean'), { ...RUN, browser, record: captured.record });

    expect(captured.entries.map((entry) => entry.seq)).toEqual(
      captured.entries.map((_entry, index) => index),
    );
  });

  it('stamps every entry with the capability it came from', async () => {
    const captured = capture();
    await runFlow(balanceFlow(), input('clean'), {
      ...RUN,
      browser,
      record: captured.record,
      runId: 'run_fixed',
      capabilityVersion: '1.4.0',
    });

    for (const entry of captured.entries) {
      expect(entry).toMatchObject({
        runId: 'run_fixed',
        capabilityId: 'checkAccountBalance',
        capabilityVersion: '1.4.0',
        phase: 'replay',
      });
    }
  });

  it('carries the run id on a thrown hard failure, so the record can be found', async () => {
    const error = await rejection(
      runFlow(balanceFlow({ withOutcomes: false }), input('clean', 'ACC-9999'), {
        ...RUN,
        browser,
        runId: 'run_fixed',
      }),
    );

    expect(error.runId).toBe('run_fixed');
    expect(error.step).not.toBe('');
  });
});

// @covers artifact.stable-step-ids
describe('step ids', () => {
  it('names a failure by its step, not by its position', async () => {
    const flow = new Flow({ id: 'named', input: balanceInput })
      .open((i) => i.url, { id: 'login.open' })
      .checkpoint([byRole('heading', 'Nothing here')], { id: 'login.reached' })
      .returns(() => ({ status: 'ok' as const }));

    await expect(runFlow(flow, input('clean'), { ...RUN, browser })).rejects.toMatchObject({
      step: 'login.reached',
    });
  });

  it('derives an id from what a step does when none is given', async () => {
    // Derived from the verb and the primary target, so inserting a step above it
    // does not rename it — unlike an index.
    const captured = capture();
    const flow = new Flow({ id: 'derived', input: fields({ url: text() }) })
      .open((i) => i.url)
      .checkpoint([byRole('heading', 'Sign in')])
      .returns(() => ({ status: 'ok' as const }));

    await runFlow(flow, { url: url('clean') }, { ...RUN, browser, record: captured.record });

    expect(captured.entries.map((entry) => entry.stepId).filter(Boolean)).toContain(
      'checkpoint:role=heading name="Sign in"',
    );
  });

  it('refuses two steps with the same id', () => {
    // A step id has to mean the same thing on every run, and in every entry.
    expect(() =>
      new Flow({ id: 'dupes', input: fields({ url: text() }) })
        .open((i) => i.url, { id: 'same' })
        .checkpoint([css('body')], { id: 'same' }),
    ).toThrow(/duplicate step id/);
  });
});

// @covers dsl.optional-is-a-noop
describe('optional steps', () => {
  it('runs the branch when the target resolves', async () => {
    const captured = capture();
    const flow = new Flow({ id: 'optional', input: balanceInput })
      .open((i) => i.url, { id: 'login.open' })
      .optional(
        [css('input[name="username"]')],
        (branch) => {
          branch.fillForm([css('input[name="username"]')], (i) => i.username, { id: 'opt.fill' });
        },
        { id: 'opt' },
      )
      .checkpoint([byRole('heading', 'Sign in')], { id: 'still.here' })
      .returns(() => ({ status: 'ok' as const }));

    await runFlow(flow, input('clean'), { ...RUN, browser, record: captured.record });

    expect(captured.entries.map((entry) => entry.stepId)).toContain('opt.fill');
  });

  it('is a no-op when the target does not resolve', async () => {
    // An intermittent consent screen that simply is not there today. Not a
    // failure, and not a branch on page state — the step list stays statically
    // enumerable either way.
    const flow = new Flow({ id: 'optional', input: balanceInput })
      .open((i) => i.url, { id: 'login.open' })
      .optional(
        [css('#never-present')],
        (branch) => {
          branch.pressButton([css('#never-present')], { id: 'opt.press' });
        },
        { id: 'opt' },
      )
      .checkpoint([byRole('heading', 'Sign in')], { id: 'still.here' })
      .returns(() => ({ status: 'ok' as const }));

    await expect(runFlow(flow, input('clean'), { ...RUN, browser })).resolves.toEqual({
      status: 'ok',
    });
  });
});

describe('recovery', () => {
  it('waits out a slow load rather than failing on it', async () => {
    // "Loaded slowly" and "never loaded" stay distinguishable. The step waits
    // for its own target to become actionable; anything longer is an explicit
    // pause with a predicate and a bound.
    const slow = new Flow({
      id: 'slow',
      input: fields({ url: text(), username: text(), password: secret(), accountRef: text() }),
    })
      .open((i) => `${i.url}/login?_fx=slow&_ms=600`, { id: 'login.open' })
      .checkpoint([byRole('heading', 'Sign in')], { id: 'login.reached' })
      .returns(() => ({ status: 'ok' as const }));

    await expect(runFlow(slow, input('clean'), { ...RUN, browser })).resolves.toEqual({
      status: 'ok',
    });
  });
});

// @covers dsl.oneof-arms-enumerable
describe('oneOf', () => {
  /**
   * Sign in, taking whichever of two expected screens is in front of us.
   *
   * The arms stay enumerable, which is what keeps the flow statically
   * inspectable — this is not a branch on page state so much as a declaration
   * that two screens are both expected here.
   */
  function loginThroughEitherScreen(entry: (base: string) => string) {
    return new Flow({ id: 'oneOf', input: balanceInput })
      .open((i) => entry(i.url), { id: 'login.open' })
      .oneOf(
        [
          {
            when: [byRole('dialog')],
            then: (branch) => {
              branch.pressButton([byRole('button', 'Dismiss')], { id: 'dialog.dismiss' });
            },
          },
          { when: [byRole('heading', 'Sign in')], then: () => undefined },
        ],
        { id: 'login.screen' },
      )
      .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
      .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
      .pressButton(SIGN_IN, { id: 'login.submit' })
      .checkpoint(ON_SEARCH_SCREEN, { id: 'search.reached' })
      .returns(() => ({ status: 'ok' as const }));
  }

  it('genuinely obstructs the flow when the dialog is up', async () => {
    // Guards the two tests below. If the modal did not actually block the press,
    // the arm that dismisses it would be dead code that passed for free.
    const blocked = new Flow({ id: 'blocked', input: balanceInput })
      .open((i) => `${i.url}/login?_fx=dialog`, { id: 'login.open' })
      .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
      .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
      .pressButton(SIGN_IN, { id: 'login.submit' })
      .returns(() => ({ status: 'ok' as const }));

    const error = await rejection(runFlow(blocked, input('clean'), { ...RUN, browser }));
    expect(error.step).toBe('login.submit');
  });

  it('takes the arm whose detector matches, and dismisses the interstitial', async () => {
    const captured = capture();

    const answer = await runFlow(
      loginThroughEitherScreen((base) => `${base}/login?_fx=dialog`),
      input('clean'),
      { ...RUN, browser, record: captured.record },
    );

    expect(answer).toEqual({ status: 'ok' });
    expect(captured.entries.map((entry) => entry.stepId)).toContain('dialog.dismiss');
  });

  it('takes the other arm when the interstitial is absent', async () => {
    // The same flow, unchanged, against the screen without the dialog. Neither
    // arm is a fallback for the other — both are expected.
    const captured = capture();

    const answer = await runFlow(
      loginThroughEitherScreen((base) => `${base}/login`),
      input('clean'),
      { ...RUN, browser, record: captured.record },
    );

    expect(answer).toEqual({ status: 'ok' });
    expect(captured.entries.map((entry) => entry.stepId)).not.toContain('dialog.dismiss');
  });

  it('fails hard when no arm matches', async () => {
    // `.oneOf()` enumerates the screens a flow expects. Arriving somewhere else
    // is not a screen it can handle, and guessing would be worse than failing.
    const flow = new Flow({ id: 'unexpected', input: balanceInput })
      .open((i) => i.url, { id: 'login.open' })
      .oneOf(
        [
          { when: [byRole('heading', 'Not this screen')], then: () => undefined },
          { when: [byRole('heading', 'Nor this one')], then: () => undefined },
        ],
        { id: 'nowhere' },
      )
      .returns(() => ({ status: 'ok' as const }));

    const error = await rejection(runFlow(flow, input('clean'), { ...RUN, browser }));

    expect(error.step).toBe('nowhere');
    expect(error.observed).toContain('no arm matched');
  });
});

// @covers execution.outcomes-before-failure
describe('declaration order decides between two matching detectors', () => {
  /**
   * Both detectors match the not-found screen at once: its banner reads "No such
   * account: ACC-9999", so the phrase and the reference are both on the page.
   *
   * The unit tier proves `decideVerification` takes the first match. This proves
   * the engine feeds it detectors in declaration order, against a real page —
   * which is the half a pure function cannot check.
   */
  function twoMatchingDetectors(reversed: boolean) {
    const start = new Flow({ id: 'ordered', input: balanceInput })
      .open((i) => `${i.url}/login`, { id: 'login.open' })
      .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
      .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
      .pressButton(SIGN_IN, { id: 'login.submit' })
      .fillForm(ACCOUNT_REF_FIELD, (i) => i.accountRef, { id: 'search.ref' })
      .pressButton(LOOK_UP, { id: 'search.submit' });

    const declared = reversed
      ? start
          .outcome([byText('ACC-9999')], () => ({ status: 'by_reference' as const }), {
            id: 'o.ref',
          })
          .outcome([byText('No such account')], () => ({ status: 'by_phrase' as const }), {
            id: 'o.phrase',
          })
      : start
          .outcome([byText('No such account')], () => ({ status: 'by_phrase' as const }), {
            id: 'o.phrase',
          })
          .outcome([byText('ACC-9999')], () => ({ status: 'by_reference' as const }), {
            id: 'o.ref',
          });

    return declared
      .checkpoint(BALANCE, { id: 'balance.present' })
      .returns(() => ({ status: 'ok' as const }));
  }

  it('takes the first declared detector', async () => {
    const answer = await runFlow(twoMatchingDetectors(false), input('clean', 'ACC-9999'), {
      ...RUN,
      browser,
    });

    expect(answer).toEqual({ status: 'by_phrase' });
  });

  it('takes the other one when the declarations are swapped', async () => {
    // Same page, same two detectors, different order. If anything other than
    // declaration order were deciding, this pair could not both pass.
    const answer = await runFlow(twoMatchingDetectors(true), input('clean', 'ACC-9999'), {
      ...RUN,
      browser,
    });

    expect(answer).toEqual({ status: 'by_reference' });
  });
});

// @covers errors.hard-failure-is-typed
describe('a session that ends mid-flow', () => {
  it('comes back as a declared outcome when the flow declares one', async () => {
    // `SessionExpired` exists in the taxonomy but nothing throws it: telling "the
    // session expired" from "a checkpoint failed" needs a rule about what a login
    // screen looks like, and that belongs to a flow rather than to the engine.
    // This is what a flow that cares does instead.
    const flow = new Flow({ id: 'expiring', input: balanceInput })
      .open((i) => `${i.url}/login`, { id: 'login.open' })
      .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
      .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
      .pressButton(SIGN_IN, { id: 'login.submit' })
      .checkpoint(ON_SEARCH_SCREEN, { id: 'search.reached' })
      .open((i) => `${i.url}/search?_fx=session-expired`, { id: 'session.expire' })
      .outcome([byText('Your session expired')], () => ({ status: 'session_expired' as const }), {
        id: 'outcome.expired',
      })
      .checkpoint(ON_SEARCH_SCREEN, { id: 'search.again' })
      .returns(() => ({ status: 'ok' as const }));

    const answer = await runFlow(flow, input('clean'), { ...RUN, browser });

    expect(answer).toEqual({ status: 'session_expired' });
  });

  it('is a hard failure when the flow does not declare it', async () => {
    const flow = new Flow({ id: 'expiring', input: balanceInput })
      .open((i) => `${i.url}/login`, { id: 'login.open' })
      .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
      .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
      .pressButton(SIGN_IN, { id: 'login.submit' })
      .open((i) => `${i.url}/search?_fx=session-expired`, { id: 'session.expire' })
      .checkpoint(ON_SEARCH_SCREEN, { id: 'search.again' })
      .returns(() => ({ status: 'ok' as const }));

    const error = await rejection(runFlow(flow, input('clean'), { ...RUN, browser }));

    expect(error.step).toBe('search.again');
  });
});
