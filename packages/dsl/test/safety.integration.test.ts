import { startAll, type FixtureBundle } from '@interfacer/fixtures';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_EFFECTS,
  EffectsRefused,
  isReplayError,
  makeSecret,
  runFlow,
  type Effects,
  type Entry,
  type Resolver,
} from '@interfacer/dsl';

import {
  approvedTransferFlow,
  balanceFlow,
  transferFlow,
  twoTransfersFlow,
  type BalanceInput,
  type TransferInput,
} from './flows.js';

/**
 * What the engine refuses to run, and what it still runs.
 *
 * A guardrail that is only established and never enforced is documentation, so
 * these drive the engine rather than the rules: `safety.unit.test.ts` decides
 * which flows the declaration admits, and this decides what actually happens to
 * a run when it does not — including the half that matters most, which is that
 * the refused run never reached the application at all.
 */

let bundle: FixtureBundle;
let browser: Browser;

beforeAll(async () => {
  [bundle, browser] = await Promise.all([startAll(), chromium.launch()]);
}, 60_000);

afterAll(async () => {
  await Promise.all([bundle.closeAll(), browser.close()]);
});

function balanceInput(): BalanceInput {
  return {
    url: bundle.fixtures.clean.url,
    username: 'teller1',
    password: makeSecret('s3cret-teller'),
    accountRef: 'ACC-1001',
  };
}

function transferInput(): TransferInput {
  return {
    url: bundle.fixtures.clean.url,
    username: 'teller1',
    password: makeSecret('s3cret-teller'),
    fromRef: 'ACC-1001',
    toRef: 'ACC-1002',
    amount: '25.00',
  };
}

function effects(overrides: Partial<Effects>): Effects {
  return { ...DEFAULT_EFFECTS, ...overrides };
}

const IRREVERSIBLE = effects({ mutates: 'write', reversible: 'no' });
const CHANGES_AUTHORITY = effects({ mutates: 'write', securityEffect: 'authority-change' });

function capture(): { entries: Entry[]; record: (entry: Entry) => void } {
  const entries: Entry[] = [];
  return {
    entries,
    record: (entry) => {
      entries.push(entry);
    },
  };
}

const approve: Resolver = () => Promise.resolve(true);
const RUN = { timeoutMs: 1_500, retries: 1 } as const;

// @covers effects.irreversible-requires-approval
describe('an irreversible capability whose flow asks nobody', () => {
  it('is refused before it reaches the application', async () => {
    const captured = capture();

    const failure = await runFlow(transferFlow(IRREVERSIBLE), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: approve,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EffectsRefused);
    expect(isReplayError(failure) && failure.step).toBe('transfer.commit');

    // The point of refusing early rather than at the commit: nothing was driven,
    // so there is no question of what the half-run left behind.
    expect(captured.entries.some((entry) => entry.kind === 'navigation')).toBe(false);
    expect(captured.entries.some((entry) => entry.kind === 'effect.performed')).toBe(false);
  });

  it('says so in the record, as a started run that failed', async () => {
    // A refusal a caller cannot see in the record is indistinguishable from a run
    // that never happened.
    const captured = capture();

    await runFlow(transferFlow(IRREVERSIBLE), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
    }).catch(() => undefined);

    expect(captured.entries.map((entry) => entry.kind)).toEqual([
      'run.started',
      'error',
      'run.finished',
    ]);
    expect(captured.entries.at(-1)).toMatchObject({
      status: { ending: 'failure', category: 'hard-failure' },
    });
  });

  it('runs unchanged once an approval precedes the commit', async () => {
    // The enforcement has to leave the legitimate case alone: the same
    // declaration, on a flow that asks.
    const captured = capture();

    const answer = await runFlow(approvedTransferFlow({ effects: IRREVERSIBLE }), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: approve,
    });

    expect(answer).toMatchObject({ status: 'ok' });
    expect(captured.entries.some((entry) => entry.kind === 'effect.performed')).toBe(true);
  });

  // @covers effects.approval-is-spent
  it('spends the approval, so each commit is linked to its own', async () => {
    const captured = capture();

    await runFlow(twoTransfersFlow({ effects: IRREVERSIBLE }), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
      resolver: approve,
    });

    const approvals = captured.entries.filter((entry) => entry.kind === 'pause');
    const performed = captured.entries.filter((entry) => entry.kind === 'effect.performed');

    expect(approvals).toHaveLength(2);
    expect(performed).toHaveLength(2);
    // The second commit points at the second approval. Carrying the first one
    // forward would record that a human authorized something they never saw.
    expect(performed.map((entry) => entry.approvedBySeq)).toEqual(
      approvals.map((entry) => entry.seq),
    );
  });
});

// @covers effects.security-effect-forces-attended
describe('a capability that changes who can access the account', () => {
  it('is refused a headless session, approval or not', async () => {
    const captured = capture();

    const failure = await runFlow(
      approvedTransferFlow({ effects: CHANGES_AUTHORITY }),
      transferInput(),
      { ...RUN, browser, record: captured.record, resolver: approve },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EffectsRefused);
    expect(isReplayError(failure) && failure.observed).toBe('headless');
    expect(captured.entries.some((entry) => entry.kind === 'navigation')).toBe(false);
  });

  it('is refused an unapproved flow even where a human is watching', async () => {
    // Headed satisfies the attended half and nothing else: the dimension forces
    // both, and a session somebody is watching is not a decision somebody made.
    // `headless: false` beside a supplied browser is the declaration and not a
    // window — Playwright exposes no way to ask a `Browser` how it was launched,
    // so the option is what the check reads either way.
    const failure = await runFlow(transferFlow(CHANGES_AUTHORITY), transferInput(), {
      ...RUN,
      browser,
      headless: false,
      record: () => undefined,
      resolver: approve,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EffectsRefused);
    expect(isReplayError(failure) && failure.step).toBe('transfer.commit');
  });
});

describe('a capability whose allowlist could never admit anything', () => {
  it('is refused before a browser opens, rather than crashing a request handler', async () => {
    // The pattern is matched against `URL.hostname`, which carries no port, so
    // `127.0.0.1:4001` admits nothing while reading as though it names a host.
    // It used to be validated inside `checkAllowlist`, which runs from a
    // Playwright `page.on("request")` handler — so the throw was unhandled and
    // took the process down with a stack trace and no record at all.
    const captured = capture();

    const failure = await runFlow(balanceFlow({ allowlist: ['127.0.0.1:4001'] }), balanceInput(), {
      ...RUN,
      browser,
      record: captured.record,
    }).catch((error: unknown) => error);

    expect(isReplayError(failure)).toBe(true);
    expect(isReplayError(failure) && failure.observed).toContain('127.0.0.1:4001');

    // A started run that failed, with nothing driven — the same shape every
    // other refusal from the artifact takes.
    expect(captured.entries.map((entry) => entry.kind)).toEqual([
      'run.started',
      'error',
      'run.finished',
    ]);
    expect(captured.entries.some((entry) => entry.kind === 'navigation')).toBe(false);
  });

  it('refuses a wildcard that was always capable of taking the process down', async () => {
    // The same hazard, latent since the rule was written: a bare `*` reached the
    // identical throw. Nobody hit it because no model proposes one.
    const captured = capture();

    const failure = await runFlow(balanceFlow({ allowlist: ['*'] }), balanceInput(), {
      ...RUN,
      browser,
      record: captured.record,
    }).catch((error: unknown) => error);

    expect(isReplayError(failure)).toBe(true);
    expect(captured.entries.some((entry) => entry.kind === 'run.finished')).toBe(true);
  });
});
