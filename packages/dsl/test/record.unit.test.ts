import { describe, expect, it } from 'vitest';

import { createEntryFactory, makeSecret, type Entry, type RunContext } from '@interfacer/dsl';

const CONTEXT: RunContext = {
  runId: 'run_01HQ',
  capabilityId: 'checkAccountBalance',
  capabilityVersion: '1.4.0',
  phase: 'replay',
};

/** A fixed clock, so a record is reproducible rather than merely plausible. */
function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function factory(): ReturnType<typeof createEntryFactory> {
  return createEntryFactory(CONTEXT, { now: fixedClock('2026-03-14T10:00:00.000Z') });
}

// @covers record.common-envelope
describe('the envelope', () => {
  it('stamps every entry with the run, the capability and its version', () => {
    // One project is one capability, so the capability's version is the
    // project's — which is what lets a run be traced to the artifact that
    // produced it without a hand-maintained number beside a real one.
    const entry = factory().entry({ kind: 'checkpoint', satisfied: true }, 'login.submit');

    expect(entry).toMatchObject({
      runId: 'run_01HQ',
      capabilityId: 'checkAccountBalance',
      capabilityVersion: '1.4.0',
      phase: 'replay',
      stepId: 'login.submit',
      seq: 0,
      timestamp: '2026-03-14T10:00:00.000Z',
    });
  });

  it('omits stepId on entries that are about the run rather than a step', () => {
    const entry = factory().entry({
      kind: 'run.started',
      inputNames: ['url'],
      secretInputNames: [],
      dataClasses: ['non-identifying'],
      effectsDeclared: false,
    });

    expect(Object.hasOwn(entry, 'stepId')).toBe(false);
  });

  it('numbers entries so they can reference one another', () => {
    const entries = factory();

    const approval = entries.entry(
      {
        kind: 'pause',
        reason: 'awaiting-decision',
        declared: true,
        expiresAt: '2026-01-01T00:05:00.000Z',
      },
      'transfer.commit',
    );
    const effect = entries.entry(
      {
        kind: 'effect.performed',
        dimension: 'reversible',
        value: 'no',
        approvedBySeq: approval.seq,
      },
      'transfer.commit',
    );

    // This link is what turns the effects declarations from a claim in the
    // contract into something observable after the fact: an auditor can answer
    // "did anything irreversible happen, and was it authorized" by reading the
    // record rather than inferring it from a button press.
    expect(approval.seq).toBe(0);
    expect(effect.seq).toBe(1);
    expect(effect).toMatchObject({ approvedBySeq: 0 });
  });

  it('exposes the seq the next entry will take', () => {
    const entries = factory();

    expect(entries.nextSeq).toBe(0);
    entries.entry({ kind: 'checkpoint', satisfied: true }, 'a');
    expect(entries.nextSeq).toBe(1);
  });

  it('records the absence of an approval just as plainly', () => {
    const effect = factory().entry(
      { kind: 'effect.performed', dimension: 'mutates', value: 'write', approvedBySeq: null },
      'transfer.commit',
    );

    // If an approval is missing where one was required, the record shows that
    // too — the field is explicitly null rather than quietly absent.
    expect(effect).toMatchObject({ approvedBySeq: null });
  });

  it('freezes entries, because the record is append-only', () => {
    expect(Object.isFrozen(factory().entry({ kind: 'checkpoint', satisfied: true }, 'a'))).toBe(
      true,
    );
  });

  it('carries the variant stamp on run.started', () => {
    // Every run carries the provenance of the artifact that produced it. It is
    // what makes the realistic multi-tenant failure — a copied sibling project
    // pointed at another institution — findable rather than guessable.
    const entry = factory().entry({
      kind: 'run.started',
      inputNames: ['url', 'username'],
      secretInputNames: ['password'],
      dataClasses: ['non-identifying'],
      effectsDeclared: false,
      variant: {
        capability: 'checkAccountBalance',
        vendor: 'CoreBankingCo',
        appVersion: '11.4',
        recordedAgainst: 'fcu-demo.example.com',
        recordedOn: '2026-03-14',
      },
    });

    expect(entry).toMatchObject({ variant: { recordedAgainst: 'fcu-demo.example.com' } });
  });
});

describe('what an entry may carry', () => {
  it('records input names, never values', () => {
    const entry = factory().entry({
      kind: 'run.started',
      inputNames: ['url', 'username', 'password'],
      secretInputNames: ['password'],
      dataClasses: ['non-identifying'],
      effectsDeclared: false,
    });

    // Structural, not filtered: there is no field on this entry that a value
    // could be put in, so forgetting to redact is not a mistake available here.
    expect(JSON.stringify(entry)).toContain('"password"');
    expect(entry).toMatchObject({ secretInputNames: ['password'] });
  });

  it('serializes to one line of JSON with no secret surviving', () => {
    // The record is a log stream, emitted one entry per line. A secret that
    // reached an entry would land in it, so this is the belt to Secret's braces.
    const entry = factory().entry(
      {
        kind: 'error',
        category: 'hard-failure',
        expected: 'Account summary',
        observed: `login failed for ${makeSecret('hunter2-Sentinel')}`,
      },
      'login.submit',
    );

    const line = JSON.stringify(entry);

    expect(line).not.toContain('hunter2-Sentinel');
    expect(line).toContain('[redacted]');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('records which strategy resolved a target, and whether that is drift', () => {
    const entry = factory().entry(
      { kind: 'step.finished', resolvedBy: 'css', strategyIndex: 1, drifted: true },
      'balance.read',
    );

    // A fallback winning means the application changed in a way the artifact
    // survived by luck. It is reported with the run rather than passing
    // silently.
    expect(entry).toMatchObject({ resolvedBy: 'css', strategyIndex: 1, drifted: true });
  });

  it('records a navigation with the resolved URL and the verdict on it', () => {
    const denied = factory().entry(
      {
        kind: 'navigation',
        url: 'https://tracker.example/collect',
        allowed: false,
        reason: 'host-not-allowed',
      },
      'login.submit',
    );

    expect(denied).toMatchObject({ allowed: false, reason: 'host-not-allowed' });
  });

  it('records a model turn with its stated reason and what it cost', () => {
    const entry = createEntryFactory(
      { ...CONTEXT, phase: 'discovery' },
      { now: fixedClock('2026-03-14T10:00:00.000Z') },
    ).entry({
      kind: 'model.turn',
      reason: 'the account number field is the only unfilled input',
      tool: 'fillForm',
      usage: { inputTokens: 12_000, outputTokens: 300, cacheReadInputTokens: 40_000 },
      costUsd: 0.0875,
    });

    // `model.turn` is what makes the record answer "what did the agent do and
    // why" rather than only what it did, and it is why discovery and replay
    // records differ in length rather than in kind.
    expect(entry).toMatchObject({
      phase: 'discovery',
      reason: 'the account number field is the only unfilled input',
      tool: 'fillForm',
    });
  });
});

// @covers record.same-format-both-phases
describe('both phases produce the same format', () => {
  it('differs only in the phase stamped on the envelope', () => {
    const shared = { kind: 'checkpoint', satisfied: true } as const;
    const clock = { now: fixedClock('2026-03-14T10:00:00.000Z') };

    const discovery = createEntryFactory({ ...CONTEXT, phase: 'discovery' }, clock).entry(
      shared,
      'login.submit',
    );
    const replay = createEntryFactory({ ...CONTEXT, phase: 'replay' }, clock).entry(
      shared,
      'login.submit',
    );

    // One format, so a run that was recorded and a run that replayed are read
    // side by side.
    const withoutPhase = ({ phase: _phase, ...rest }: Entry): Omit<Entry, 'phase'> => rest;

    expect(withoutPhase(discovery)).toEqual(withoutPhase(replay));
    expect(discovery.phase).toBe('discovery');
    expect(replay.phase).toBe('replay');
  });
});

// @covers record.interview-has-no-version
describe('an interview entry', () => {
  it('carries no capability version, because no project exists to have one', () => {
    // The interview settles the contract the project will be built from, so the
    // `package.json` whose version the envelope would carry does not exist yet.
    // Everything else is known before the first question.
    const { capabilityVersion: _omitted, ...withoutVersion } = CONTEXT;
    const entry = createEntryFactory(
      { ...withoutVersion, phase: 'interview' },
      { now: fixedClock('2026-03-14T10:00:00.000Z') },
    ).entry({ kind: 'proposal.put', field: 'allowlist', accepted: true });

    expect(entry).toMatchObject({
      runId: 'run_01HQ',
      capabilityId: 'checkAccountBalance',
      phase: 'interview',
      seq: 0,
    });
    // Absent, not empty and not a placeholder: a version nobody assigned would
    // read as one somebody did.
    expect('capabilityVersion' in entry).toBe(false);
  });

  it('still carries a version when a rerun has a project to take one from', () => {
    const entry = createEntryFactory(
      { ...CONTEXT, phase: 'interview' },
      { now: fixedClock('2026-03-14T10:00:00.000Z') },
    ).entry({ kind: 'answer.recorded', fields: ['task'], authority: 'human' });

    expect(entry.capabilityVersion).toBe('1.4.0');
  });
});
