import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Entry, Usage } from '@interfacer/dsl';
import {
  generateProject,
  interview,
  recordedAnswers,
  writeProject,
  type Ask,
  type Converse,
  type InterviewState,
  type Question,
  type Turn,
} from 'interfacer';
import { describe, expect, it } from 'vitest';

import { balanceCapability, partialCapability, variant } from './capability.js';

/**
 * The interview, conducted by a scripted model.
 *
 * These test Interfacer's half of the conversation rather than the model's:
 * which answers a patch is allowed to settle, what a proposal costs, what is
 * reported missing, and what a rerun against an existing project still has to
 * ask. The scripted `converse` is a fake — it returns predetermined tool calls
 * and nothing asserts how it was called.
 *
 * There is no browser here. The contract is settled before anything is driven,
 * which is the whole reason a missing credential costs a second rather than an
 * entire interview.
 */

const USAGE: Usage = {
  inputTokens: 900,
  outputTokens: 150,
  cacheReadInputTokens: 4_000,
  cacheCreationInputTokens: 0,
};

let nextId = 0;

function turn(...calls: readonly { name: string; input: Record<string, unknown> }[]): Turn {
  return {
    text: '',
    usage: USAGE,
    calls: calls.map((call) => ({ id: `call_${String(nextId++)}`, ...call })),
  };
}

/** A model that says exactly this, and then that it is done. */
function script(...turns: readonly Turn[]): { converse: Converse; seen: InterviewState[] } {
  const seen: InterviewState[] = [];
  let index = 0;

  return {
    seen,
    converse: (state) => {
      seen.push(state);
      return Promise.resolve(turns[index++] ?? turn({ name: 'settled', input: {} }));
    },
  };
}

/** Everything the interview establishes except the two guardrails. */
const ORDINARY = {
  capability: 'checkAccountBalance',
  task: 'sign in to mybank and read the balance of an account',
  entryPoint: 'https://mybank.invalid/',
  output: 'an object with one property, balance, a number',
  inputs: [
    { name: 'url', kind: 'text', description: 'entry point' },
    { name: 'username', kind: 'text', description: 'the operator to sign in as' },
    { name: 'password', kind: 'secret', description: 'the operator password' },
    { name: 'accountRef', kind: 'text', description: 'account to look up' },
  ],
  outcomes: [{ id: 'account_not_found', description: 'no account with that reference' }],
  interactions: [],
  effects: {
    mutates: 'read',
    reversible: 'yes',
    scope: 'single',
    external: 'none',
    financial: 'none',
    dataClasses: ['PII'],
  },
};

const FILE = [
  '# balance capability',
  '',
  'Sign in to mybank and read the balance of an account.',
  'The password is a secret. It only reads; it changes nothing.',
  'The account may not exist.',
  'The automation may visit mybank.invalid and auth.mybank.invalid.',
  'It does not change who can access the account, so securityEffect is none.',
  'Spend at most $4 discovering it.',
].join('\n');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'interfacer-session-'));
}

// @covers interview.file-is-the-authorization
describe('a pre-answered interview', () => {
  it('turns the prose into a contract, with the file authorizing the guardrails', async () => {
    const { converse } = script(
      turn(
        { name: 'record', input: ORDINARY },
        {
          name: 'record',
          input: {
            allowlist: ['mybank.invalid', 'auth.mybank.invalid'],
            effects: { securityEffect: 'none' },
            budgetUsd: 4,
            citation: 'may visit mybank.invalid and auth.mybank.invalid',
          },
        },
      ),
      turn({ name: 'settled', input: {} }),
    );

    const result = await interview({ converse, file: FILE });

    expect(result.ending).toBe('settled');
    expect(result.missing).toEqual([]);
    expect(result.contract?.capability).toBe('checkAccountBalance');
    expect(result.contract?.inputs.find((one) => one.name === 'password')?.kind).toBe('secret');
    expect(result.contract?.outcomes).toEqual([
      { id: 'account_not_found', description: 'no account with that reference' },
    ]);
    expect(result.contract?.allowlist).toEqual(['mybank.invalid', 'auth.mybank.invalid']);
    expect(result.contract?.budgetUsd).toBe(4);
    // A human wrote and committed the file, so the file is the authorization.
    expect(result.contract?.authority).toEqual({ allowlist: 'file', securityEffect: 'file' });
    // Discovery resends its history, so cached and uncached input are counted
    // at their own rates rather than one.
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('exits saying which answers are missing, and only those', async () => {
    const withoutHosts = FILE.replace(
      'The automation may visit mybank.invalid and auth.mybank.invalid.\n',
      '',
    );

    const { converse } = script(
      turn(
        { name: 'record', input: { ...ORDINARY, budgetUsd: 4 } },
        {
          // The model proposing a guardrail the file does not state: the quote
          // is not there, so nothing is recorded and the answer stays missing.
          name: 'record',
          input: {
            allowlist: ['mybank.invalid'],
            effects: { securityEffect: 'none' },
            citation: 'the automation may visit mybank.invalid',
          },
        },
      ),
    );

    const result = await interview({ converse, file: withoutHosts });

    expect(result.contract).toBeUndefined();
    expect(result.ending).toBe('incomplete');
    expect(result.missing.map((gap) => gap.id)).toEqual(['effects.securityEffect', 'allowlist']);
  });
});

// @covers agent.no-default-budget
describe('an unattended run with no budget', () => {
  it('is a missing answer like any other', async () => {
    const { converse } = script(
      turn(
        { name: 'record', input: ORDINARY },
        {
          name: 'record',
          input: {
            allowlist: ['mybank.invalid', 'auth.mybank.invalid'],
            effects: { securityEffect: 'none' },
            citation: 'may visit mybank.invalid and auth.mybank.invalid',
          },
        },
      ),
    );

    const result = await interview({
      converse,
      file: FILE.replace('Spend at most $4 discovering it.', ''),
    });

    expect(result.contract).toBeUndefined();
    expect(result.missing.map((gap) => gap.id)).toEqual(['budget']);
  });
});

// @covers position.guardrails-human-authored allowlist.confirmed-not-inferred session.human-channel-is-prose
describe('the guardrails Interfacer proposes', () => {
  /** A person who accepts what is put to them and answers what is asked. */
  function person(answers: Record<string, string> = {}): { ask: Ask; asked: Question[] } {
    const asked: Question[] = [];
    return {
      asked,
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(
          question.kind === 'confirm' ? 'yes' : (answers[question.text] ?? 'go on'),
        );
      },
    };
  }

  it('are recorded when the person confirms, and not when the model records them itself', async () => {
    const { converse } = script(
      turn(
        { name: 'record', input: ORDINARY },
        // The model settling its own constraint. Refused: it has to be put.
        { name: 'record', input: { allowlist: ['mybank.invalid'] } },
      ),
      turn(
        {
          name: 'propose',
          input: {
            field: 'allowlist',
            value: ['mybank.invalid', 'auth.mybank.invalid'],
            why: 'the task names mybank, and sign-in redirects to auth',
          },
        },
        { name: 'propose', input: { field: 'securityEffect', value: 'none' } },
      ),
      turn({ name: 'settled', input: {} }),
    );

    const { ask, asked } = person();
    const result = await interview({ converse, ask });

    expect(result.ending).toBe('settled');
    expect(result.contract?.allowlist).toEqual(['mybank.invalid', 'auth.mybank.invalid']);
    expect(result.contract?.authority).toEqual({ allowlist: 'human', securityEffect: 'human' });
    // Put to the person with its value visible: the confirmation is the point.
    expect(asked.map((question) => question.kind)).toEqual(['confirm', 'confirm']);
    expect(asked[0]?.text).toContain('auth.mybank.invalid');
  });

  it('are not recorded when the person declines', async () => {
    const { converse } = script(
      turn({ name: 'record', input: ORDINARY }),
      turn({ name: 'propose', input: { field: 'allowlist', value: ['mybank.invalid'] } }),
    );

    const declining: Ask = (question) =>
      Promise.resolve(question.kind === 'confirm' ? 'no, cdn.mybank.net too' : 'go on');

    const result = await interview({ converse, ask: declining });

    expect(result.contract).toBeUndefined();
    expect(result.missing.map((gap) => gap.id)).toContain('allowlist');
  });

  it('cannot be confirmed by a proposal where nobody is present', async () => {
    const { converse } = script(
      turn({ name: 'record', input: { ...ORDINARY, budgetUsd: 4 } }),
      turn({ name: 'propose', input: { field: 'allowlist', value: ['mybank.invalid'] } }),
    );

    const result = await interview({ converse, file: FILE });

    // Unattended there is nobody to confirm, so a proposal is not an answer.
    expect(result.contract).toBeUndefined();
    expect(result.missing.map((gap) => gap.id)).toContain('allowlist');
  });
});

// @covers interview.rerun-is-a-delta interview.never-written-back
describe('a rerun against an existing project', () => {
  async function existing(): Promise<string> {
    const dir = scratch();
    const files = await generateProject({
      flow: balanceCapability({ allowlist: ['clean.fixture.invalid', '*.fixture.invalid'] }),
      packageName: 'mybank-balance',
      description: 'Read a checking account balance.',
      variant,
    });
    await writeProject(files, join(dir, 'mybank-balance'));
    return join(dir, 'mybank-balance');
  }

  it('asks only what the new goal leaves unsettled', async () => {
    const project = await existing();
    const seed = recordedAnswers(project);

    const { converse, seen } = script(
      turn({
        name: 'record',
        input: {
          task: 'read the balance of an account at the Northwind tenant',
          entryPoint: 'https://northwind.invalid/',
        },
      }),
      turn({ name: 'settled', input: {} }),
    );

    const result = await interview({
      converse,
      ask: () => Promise.resolve('go on'),
      seed,
      rerun: true,
    });

    // The project's own declarations are the recorded answers, so what is left
    // to ask is the goal and the entry point the new tenant changes.
    expect(seen[0]?.outstanding.map((gap) => gap.id)).toEqual(['task', 'entryPoint']);
    expect(seen[0]?.seeded).toBe(true);
    expect(result.ending).toBe('settled');
    expect(result.contract?.capability).toBe('checkAccountBalance');
    expect(result.contract?.allowlist).toEqual(['clean.fixture.invalid', '*.fixture.invalid']);
    expect(result.contract?.inputs.map((input) => input.name)).toEqual([
      'url',
      'username',
      'password',
      'accountRef',
    ]);
    // Re-running an unchanged capability costs a confirmation, not a second
    // pass: nobody was asked to restate the effects or the outcomes.
    expect(result.contract?.effects.dataClasses).toEqual(['non-identifying']);
    expect(result.contract?.outcomes.map((outcome) => outcome.id)).toEqual([
      'account_not_found',
      'permission_denied',
    ]);
  });

  it('asks what a run can end in again where the last one stopped early', async () => {
    // A partial project is the normal outcome of a stalled or budget-stopped
    // run, and the flow it wrote declares no outcomes because it never reached
    // one — not because the person said there are none. Reading that as an
    // answer is how two declared outcomes went missing in a live session: the
    // question was never outstanding, so the model never recorded what it was
    // told, and the capability that was generated could not report either.
    const dir = scratch();
    const files = await generateProject({
      flow: partialCapability({ allowlist: ['clean.fixture.invalid', '*.fixture.invalid'] }),
      packageName: 'mybank-balance',
      description: 'Read a checking account balance.',
      variant,
    });
    await writeProject(files, join(dir, 'mybank-balance'));

    const seed = recordedAnswers(join(dir, 'mybank-balance'));

    const { converse, seen } = script(
      turn({
        name: 'record',
        input: {
          task: 'read the balance of an account',
          entryPoint: 'https://mybank.invalid/',
          output: 'status ok with the balance',
          outcomes: [{ id: 'account_not_found', description: 'no account with that reference' }],
        },
      }),
      turn({ name: 'settled', input: {} }),
    );

    const result = await interview({
      converse,
      ask: () => Promise.resolve('go on'),
      seed,
      rerun: true,
    });

    expect(seen[0]?.outstanding.map((gap) => gap.id)).toContain('outcomes');
    expect(result.contract?.outcomes.map((outcome) => outcome.id)).toEqual(['account_not_found']);
  });

  it('writes no interview file back', async () => {
    const project = await existing();
    const before = readdirSync(project, { recursive: true, encoding: 'utf8' }).sort();

    const path = join(project, '..', 'answers.md');
    writeFileSync(path, FILE);

    const { converse } = script(
      turn({
        name: 'record',
        input: {
          task: 'read the balance at the Northwind tenant',
          entryPoint: 'https://northwind.invalid/',
          budgetUsd: 4,
        },
      }),
      turn({ name: 'settled', input: {} }),
    );

    await interview({ converse, file: FILE, seed: recordedAnswers(project) });

    // There would be nothing to write that the project does not already hold,
    // and a prose copy of the contract would drift the moment somebody edited
    // the flow by hand — which the flow is meant to be.
    expect(readdirSync(project, { recursive: true, encoding: 'utf8' }).sort()).toEqual(before);
    expect(readFileSync(path, 'utf8')).toBe(FILE);
  });
});

describe('a turn that calls no tool, mid-interview', () => {
  it('is recovered from rather than derailing the contract', async () => {
    // A refusal comes back as an assistant message with no content at all —
    // `stop_reason: "refusal"`, zero blocks — which is indistinguishable here
    // from any other turn that called nothing. The interview must survive it:
    // an empty exchange rendered into the conversation is a message the
    // provider rejects, and it poisons every request built afterwards.
    const { converse, seen } = script(
      turn(),
      turn(
        { name: 'record', input: ORDINARY },
        {
          name: 'record',
          input: {
            allowlist: ['mybank.invalid', 'auth.mybank.invalid'],
            effects: { securityEffect: 'none' },
            budgetUsd: 4,
            citation: 'may visit mybank.invalid and auth.mybank.invalid',
          },
        },
      ),
      turn({ name: 'settled', input: {} }),
    );

    const result = await interview({ converse, file: FILE });

    expect(result.ending).toBe('settled');
    expect(result.contract?.capability).toBe('checkAccountBalance');

    const said = (seen.at(-1)?.transcript ?? []).filter((one) => one.kind === 'nudge');
    expect(said).toHaveLength(1);
  });
});

// @covers record.interview-records-decisions-not-prose
describe('what the interview writes into the run record', () => {
  it('records the fields settled and the authority behind them, never the prose', async () => {
    const entries: Entry[] = [];
    const { converse } = script(
      turn(
        { name: 'record', input: ORDINARY },
        {
          name: 'record',
          input: {
            allowlist: ['mybank.invalid', 'auth.mybank.invalid'],
            effects: { securityEffect: 'none' },
            budgetUsd: 4,
            citation: 'may visit mybank.invalid and auth.mybank.invalid',
          },
        },
      ),
      turn({ name: 'settled', input: {} }),
    );

    const result = await interview({
      converse,
      file: FILE,
      capabilityId: 'checkAccountBalance',
      record: (entry) => entries.push(entry),
    });

    expect(result.ending).toBe('settled');

    // The phase is stamped, and no project exists yet to have a version.
    expect(entries.every((entry) => entry.phase === 'interview')).toBe(true);
    expect(entries.every((entry) => !('capabilityVersion' in entry))).toBe(true);

    // What was decided, and what admitted it.
    const recorded = entries.filter((entry) => entry.kind === 'answer.recorded');
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((entry) => entry.authority === 'file')).toBe(true);
    expect(recorded.flatMap((entry) => entry.fields)).toContain('allowlist');

    // The cost and the turns are there, which is what makes a refusal visible.
    expect(entries.some((entry) => entry.kind === 'model.turn')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'run.finished')).toBe(true);

    // And none of the prose: not the file that authorized it, not the task the
    // person described, not a question or an answer.
    const written = entries.map((entry) => JSON.stringify(entry)).join('\n');
    expect(written).not.toContain('mybank and read the balance');
    expect(written).not.toContain('may visit mybank.invalid');
    expect(written).not.toContain(ORDINARY.task);
  });
});
