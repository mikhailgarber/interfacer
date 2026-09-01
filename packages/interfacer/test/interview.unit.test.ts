import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  applyAnswers,
  BadInvocation,
  BadProjectName,
  capabilityFrom,
  cited,
  gaps,
  IncompleteContract,
  parseArgv,
  recordedAnswers,
  resolveLocation,
  settle,
  type ContractDraft,
} from 'interfacer';
import { describe, expect, it } from 'vitest';

/**
 * The mechanical half of interview mode.
 *
 * A model conducts the conversation; what an answer has to be, which ones are
 * still missing, and who is allowed to have settled a guardrail are decided
 * here — so they are asserted here, without one.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'interfacer-interview-'));
}

/** Everything answered except the two guardrails, which each test settles. */
function answered(): ContractDraft {
  return {
    capability: 'checkAccountBalance',
    task: 'sign in and read the balance of an account',
    entryPoint: 'https://mybank.invalid/',
    inputs: [
      { name: 'username', kind: 'text' },
      { name: 'password', kind: 'secret' },
    ],
    output: 'an object with one property, balance',
    outcomes: [{ id: 'account_not_found' }],
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
}

function settled(): ContractDraft {
  return applyAnswers(
    answered(),
    { allowlist: ['mybank.invalid'], effects: { securityEffect: 'none' } },
    { by: 'human' },
  ).draft;
}

describe('what is still missing', () => {
  it('names every unanswered question and nothing else', () => {
    expect(gaps({}).map((gap) => gap.id)).toEqual([
      'capability',
      'task',
      'entryPoint',
      'inputs',
      'output',
      'outcomes',
      'interactions',
      'effects.mutates',
      'effects.reversible',
      'effects.scope',
      'effects.external',
      'effects.financial',
      'effects.dataClasses',
      'effects.securityEffect',
      'allowlist',
    ]);

    expect(gaps(settled())).toEqual([]);
  });

  it('reads an empty list as an answer and an absent one as a question', () => {
    // "This task has no business outcomes" is something a user said. "Nobody
    // asked yet" is not, and a run must not proceed on a question never put.
    const asked = { ...settled(), outcomes: [], interactions: [] };
    expect(gaps(asked)).toEqual([]);

    const { outcomes: _dropped, ...unasked } = asked;
    expect(gaps(unasked).map((gap) => gap.id)).toEqual(['outcomes']);
  });

  it('asks whether running twice is a problem only where something changes', () => {
    const read = settled();
    expect(gaps(read)).toEqual([]);

    const writes = { ...read, effects: { ...read.effects, mutates: 'write' as const } };
    expect(gaps(writes).map((gap) => gap.id)).toEqual(['effects.idempotent']);

    // A read is idempotent by construction, so the answer is entailed rather
    // than defaulted — and a write has to say.
    expect(settle(read).effects.idempotent).toBe(true);
  });
});

// @covers agent.no-default-budget
describe('a run nobody is watching', () => {
  it('needs a budget, and there is no default to fall back to', () => {
    expect(gaps(settled(), { interactive: true })).toEqual([]);

    const unattended = gaps(settled(), { interactive: false });
    expect(unattended.map((gap) => gap.id)).toEqual(['budget']);
    expect(() => settle(settled(), { interactive: false })).toThrow(IncompleteContract);

    // Stated, and the gap closes. A default nobody chose is not an authorization.
    const bounded = { ...settled(), budgetUsd: 5 };
    expect(gaps(bounded, { interactive: false })).toEqual([]);
    expect(settle(bounded, { interactive: false }).budgetUsd).toBe(5);
  });
});

// @covers position.guardrails-human-authored allowlist.confirmed-not-inferred
describe('the two guardrails Interfacer proposes', () => {
  it('are not recorded from the model in its own voice', () => {
    const applied = applyAnswers(
      answered(),
      { allowlist: ['mybank.invalid'], effects: { securityEffect: 'authority-change' } },
      { by: 'model' },
    );

    expect(applied.draft.allowlist).toBeUndefined();
    expect(applied.draft.effects?.securityEffect).toBeUndefined();
    expect(applied.refused).toHaveLength(2);
    // A model that settles its own constraint has not been constrained: the
    // answers stay missing, so the interview goes on asking for them.
    expect(gaps(applied.draft).map((gap) => gap.id)).toEqual([
      'effects.securityEffect',
      'allowlist',
    ]);
  });

  it('are recorded when a person confirms them, and carry who did', () => {
    const applied = applyAnswers(
      answered(),
      { allowlist: ['mybank.invalid', '*.mybank.invalid'] },
      { by: 'human' },
    );

    expect(applied.refused).toEqual([]);
    expect(applied.draft.allowlist).toEqual(['mybank.invalid', '*.mybank.invalid']);
    expect(applied.draft.authority?.allowlist).toBe('human');
  });

  it('keeps every other answer in a patch that overreached on one', () => {
    // Dropped rather than rejected wholesale: a model that overreaches on the
    // allowlist should not have to re-establish the task.
    const applied = applyAnswers(
      {},
      { task: 'read a balance', allowlist: ['x.invalid'] },
      {
        by: 'model',
      },
    );

    expect(applied.draft.task).toBe('read a balance');
    expect(applied.draft.allowlist).toBeUndefined();
  });
});

// @covers interview.file-is-the-authorization
describe('the interview file', () => {
  const file = [
    '# balance interview',
    '',
    'The automation may visit mybank.invalid and auth.mybank.invalid, and nothing else.',
    'It does not change who can sign in.',
  ].join('\n');

  it('authorizes a guardrail it states, quoted', () => {
    const applied = applyAnswers(
      answered(),
      {
        allowlist: ['mybank.invalid', 'auth.mybank.invalid'],
        citation: 'may visit mybank.invalid and auth.mybank.invalid',
      },
      { by: 'file', text: file },
    );

    expect(applied.refused).toEqual([]);
    expect(applied.draft.authority?.allowlist).toBe('file');
  });

  it('authorizes nothing it does not state', () => {
    const applied = applyAnswers(
      answered(),
      { allowlist: ['mybank.invalid', 'cdn.mybank.net'], citation: 'and cdn.mybank.net too' },
      { by: 'file', text: file },
    );

    // A human wrote and committed the file, so the file is the authorization
    // record — and a quote that is not in it authorizes nothing.
    expect(applied.draft.allowlist).toBeUndefined();
    expect(applied.refused[0]).toMatch(/not stated in the interview file/);
  });

  it('is quoted about the words rather than the whitespace', () => {
    expect(cited(file, 'MAY   visit\nmybank.invalid and auth.mybank.invalid')).toBe(true);
    expect(cited(file, '')).toBe(false);
    expect(cited(file, undefined)).toBe(false);
  });
});

describe('where the project goes', () => {
  it('creates a location that is not there, and reads one that is', () => {
    const root = scratch();

    expect(resolveLocation(root, 'mybank-interface')).toEqual({
      path: join(root, 'mybank-interface'),
      state: 'created',
    });
    // Second time round it exists and holds nothing: still a new project.
    expect(resolveLocation(root, 'mybank-interface').state).toBe('empty');

    writeFileSync(join(root, 'mybank-interface', 'package.json'), '{}');
    expect(resolveLocation(root, 'mybank-interface').state).toBe('occupied');
  });

  it('refuses a name that is a path rather than a directory name', () => {
    const root = scratch();
    expect(() => resolveLocation(root, '../elsewhere')).toThrow(BadProjectName);
    expect(() => resolveLocation(root, '/tmp/elsewhere')).toThrow(BadProjectName);
    expect(() => resolveLocation(root, '  ')).toThrow(BadProjectName);
  });

  it('proposes a capability id from the project name, or none it cannot', () => {
    expect(capabilityFrom('mybank-interface')).toBe('mybankInterface');
    expect(capabilityFrom('mybank.balance')).toBe('mybankBalance');
    // Already an identifier: left as the person wrote it rather than restyled.
    expect(capabilityFrom('check_balance')).toBe('check_balance');
    // It names the exported master function, so anything that cannot be an
    // identifier yields nothing and the interview asks instead.
    expect(capabilityFrom('9lives')).toBeUndefined();
    expect(capabilityFrom('---')).toBeUndefined();
  });
});

/** The built bin, spawned the way `npx interfacer` runs it. */
const CLI = resolve('packages/interfacer/dist/cli.js');

function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    cwd: scratch(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the command line', () => {
  it('takes a project name, a root and an interview file', () => {
    expect(parseArgv(['mybank-interface'], '/work')).toEqual({
      projectName: 'mybank-interface',
      root: '/work',
    });

    expect(
      parseArgv(['--root', '/elsewhere', 'mybank', '--interview', 'answers.md'], '/work'),
    ).toEqual({
      projectName: 'mybank',
      root: '/elsewhere',
      interviewPath: 'answers.md',
    });

    expect(parseArgv(['--help'], '/work')).toBe('help');
  });

  it('refuses what it cannot act on', () => {
    expect(() => parseArgv([], '/work')).toThrow(BadInvocation);
    expect(() => parseArgv(['a', 'b'], '/work')).toThrow(BadInvocation);
    expect(() => parseArgv(['--nope', 'a'], '/work')).toThrow(BadInvocation);
    expect(() => parseArgv(['a', '--root'], '/work')).toThrow(BadInvocation);
    // The goal and the entry point are established in the interview, not here.
    expect(() => parseArgv(['a', '--goal', 'read a balance'], '/work')).toThrow(BadInvocation);
  });

  it('runs as a bin, and says how it is used', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage:');

    const nothing = run([]);
    expect(nothing.status).toBe(2);
    expect(nothing.stderr).toContain('a project name is required');
  });

  it('checks for the key before it asks the first question', () => {
    // A missing key costs a second rather than an entire interview — so it is
    // checked before a location is resolved, let alone a browser opened.
    const missing = run(['mybank-interface']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('API_KEY');
    expect(missing.stderr).not.toContain('mybank-interface/');
  });

  it('refuses an interview file it cannot read, rather than asking a nobody', () => {
    const unreadable = run(['mybank-interface', '--interview', 'nowhere.md'], { API_KEY: 'k' });
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain('cannot read the interview file');
  });
});

// @covers interview.never-written-back
describe('the interview file, going the other way', () => {
  it('is an input only: nothing in the session writes one', () => {
    // A stored prose copy of the contract would drift the moment somebody
    // edited the flow by hand, and the flow is meant to be edited by hand. The
    // only honest way to say Interfacer never writes one back is to read the
    // one path that holds the file's name and see that it only ever reads.
    const sources = [
      'packages/interfacer/src/cli.ts',
      ...readdirSync('packages/interfacer/src/interview').map((name) =>
        join('packages/interfacer/src/interview', name),
      ),
    ];

    const writers = sources.filter((path) =>
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeProject)\b/.test(
        readFileSync(path, 'utf8'),
      ),
    );

    expect(writers).toEqual([]);
  });
});

// @covers interview.rerun-is-a-delta
describe("a project's own declarations", () => {
  function project(): string {
    const dir = scratch();
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src', 'contract.ts'),
      [
        "import { fields, secret, text } from '@interfacer/dsl';",
        '',
        'export const inputFields = fields({',
        "  url: text({ description: 'entry point' }),",
        '  password: secret(),',
        '});',
        '',
        'export const effects = {',
        "  mutates: 'write',",
        "  reversible: 'compensable',",
        "  securityEffect: 'none',",
        "  scope: 'single',",
        "  external: 'none',",
        "  financial: 'none',",
        '  idempotent: false,',
        "  dataClasses: ['PII'],",
        '} as const;',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'src', 'flow.ts'),
      [
        'export const flow = new Flow({',
        "  id: 'checkAccountBalance',",
        '  input: inputFields,',
        '  effects,',
        "  allowlist: ['clean.fixture.invalid', '*.fixture.invalid'],",
        '})',
        "  .open(field('url'), { id: 'login.open' })",
        // A selector with brackets and quotes in it: the reader has to skip
        // string contents rather than count every bracket it meets.
        "  .fillForm([css('input[name=\"password\"]')], field('password'), {",
        "    id: 'login.password',",
        '  })',
        '  .outcome(',
        "    [byText('No such account')],",
        "    answer('account_not_found', { accountRef: field('accountRef') }),",
        "    { id: 'account_not_found' },",
        '  )',
        "  .returns(answer('ok', { balance: extracted('balance') }));",
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'src', 'index.ts'),
      [
        'export const interactions: Readonly<Record<string, InteractionDeclaration>> = {',
        '  mfaCode: {',
        "    kind: 'input',",
        "    name: 'mfaCode',",
        "    prompt: 'Enter the code sent to your device',",
        '    secret: true,',
        '  },',
        '};',
      ].join('\n'),
    );
    return dir;
  }

  it('are the recorded answers, so a rerun asks only the delta', () => {
    const recorded = recordedAnswers(project());

    expect(recorded.capability).toBe('checkAccountBalance');
    expect(recorded.inputs).toEqual([
      { name: 'url', kind: 'text', description: 'entry point' },
      { name: 'password', kind: 'secret' },
    ]);
    expect(recorded.effects).toEqual({
      mutates: 'write',
      reversible: 'compensable',
      securityEffect: 'none',
      scope: 'single',
      external: 'none',
      financial: 'none',
      idempotent: false,
      dataClasses: ['PII'],
    });
    expect(recorded.allowlist).toEqual(['clean.fixture.invalid', '*.fixture.invalid']);
    expect(recorded.outcomes).toEqual([{ id: 'account_not_found' }]);
    expect(recorded.interactions).toEqual([
      {
        kind: 'input',
        name: 'mfaCode',
        prompt: 'Enter the code sent to your device',
        secret: true,
      },
    ]);
    expect(recorded.output).toBe('status ok with balance');

    // The allowlist a person already confirmed and committed stands: a rerun
    // costs a confirmation, not a second pass through every question.
    expect(recorded.authority).toEqual({ allowlist: 'project', securityEffect: 'project' });

    // What is left is what this run is actually about — the goal, and the
    // entry point a new tenant changes. Neither is a declaration.
    expect(gaps(recorded).map((gap) => gap.id)).toEqual(['task', 'entryPoint']);
  });

  it('are absent rather than guessed where nothing can be read', () => {
    // Fails toward asking: an unreadable declaration is a question, never an
    // answer nobody gave carried into a generated project.
    expect(gaps(recordedAnswers(scratch())).length).toBeGreaterThan(10);
  });
});
