import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startAll, type FixtureBundle } from '@interfacer/fixtures';
import {
  fields,
  field,
  Flow,
  literal,
  makeSecret,
  secret,
  text,
  type Entry,
  type Usage,
} from '@interfacer/dsl';
import { chromium, type Browser } from 'playwright';
import { discover, generate, type Ask, type Contract, type Decide, type Turn } from 'interfacer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Generation mode, driven by a scripted model.
 *
 * The second stage of a session: the model drives the task against a real
 * fixture, Interfacer provokes each declared outcome, asks what the application
 * is, and writes the project. The model is a fake returning predetermined tool
 * calls; the browser, the application and the engine are real, and the
 * assertions are about what the run produced.
 */

let bundle: FixtureBundle;
let browser: Browser;

beforeAll(async () => {
  [bundle, browser] = await Promise.all([startAll(), chromium.launch()]);
}, 60_000);

afterAll(async () => {
  await Promise.all([bundle.closeAll(), browser.close()]);
});

const USAGE: Usage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadInputTokens: 9_000,
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

/** A model that says exactly this, and then looks at the page and nothing else. */
function script(...turns: readonly Turn[]): Decide {
  let index = 0;
  return () => Promise.resolve(turns[index++] ?? turn({ name: 'snapshot', input: {} }));
}

/** Live values, as the person would supply them when the model asks. */
const LIVE = {
  username: 'teller1',
  password: 's3cret-teller',
  accountRef: 'ACC-1001',
  missingRef: 'ACC-9999',
};

/** What a sibling project's own `fields()` declaration would say. */
const SEED_INPUT = fields({ username: text(), password: secret() });

const SIGN_IN = [{ by: 'role', role: 'button', name: 'Sign in' }];
const USERNAME = [{ by: 'label', text: 'Username' }];
const PASSWORD = [{ by: 'label', text: 'Password' }];
const ACCOUNT = [{ by: 'label', text: 'Account number' }];
const LOOK_UP = [{ by: 'role', role: 'button', name: 'Look up' }];
const BALANCE = [{ by: 'css', selector: '#balance-value' }];
const NOT_FOUND = [{ by: 'text', text: 'No such account' }];

function contract(entryPoint: string, overrides: Partial<Contract> = {}): Contract {
  return {
    capability: 'checkAccountBalance',
    task: 'sign in and read the balance of an account',
    entryPoint,
    inputs: [
      { name: 'url', kind: 'text', description: 'entry point' },
      { name: 'username', kind: 'text' },
      { name: 'password', kind: 'secret' },
      { name: 'accountRef', kind: 'text', description: 'account to look up' },
    ],
    output: 'an object with one property, balance',
    outcomes: [{ id: 'account_not_found', description: 'no account with that reference' }],
    interactions: [],
    effects: {
      mutates: 'read',
      reversible: 'yes',
      securityEffect: 'none',
      scope: 'single',
      external: 'none',
      financial: 'none',
      idempotent: true,
      // What a back-office banking screen observes. It also decides what the
      // record may keep: at PII the query is stripped from every recorded URL,
      // which is what stops an account reference reaching the record through a
      // navigation without ever passing through a field.
      dataClasses: ['PII'],
    },
    allowlist: ['127.0.0.1'],
    authority: { allowlist: 'human', securityEffect: 'human' },
    ...overrides,
  };
}

/** The turns that sign in, look an account up and answer with its balance. */
function reachTheGoal(): readonly Turn[] {
  return [
    turn({ name: 'ask', input: { question: 'where does this start?', for: 'url' } }),
    turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
    turn({ name: 'ask', input: { question: 'who should I sign in as?', for: 'username' } }),
    turn({ name: 'ask', input: { question: 'and the password?', for: 'password' } }),
    turn({
      name: 'fillForm',
      input: { target: USERNAME, value: { from: 'input', name: 'username' } },
    }),
    turn({
      name: 'fillForm',
      input: { target: PASSWORD, value: { from: 'input', name: 'password' } },
    }),
    turn({ name: 'pressButton', input: { target: SIGN_IN } }),
    turn({ name: 'ask', input: { question: 'which account?', for: 'accountRef' } }),
    turn({
      name: 'fillForm',
      input: { target: ACCOUNT, value: { from: 'input', name: 'accountRef' } },
    }),
    turn({ name: 'pressButton', input: { target: LOOK_UP } }),
    turn({ name: 'extract', input: { name: 'balance', target: BALANCE, parse: 'money' } }),
    turn({ name: 'returns', input: { status: 'ok', values: { balance: 'balance' } } }),
  ];
}

/** The turns that provoke the declared outcome, then name what the pages are. */
function provokeAndInspect(): readonly Turn[] {
  return [
    turn({
      name: 'ask',
      input: { question: 'which reference does not exist?', for: 'accountRef' },
    }),
    turn({ name: 'outcome', input: { status: 'account_not_found', detector: NOT_FOUND } }),
    turn(
      { name: 'stamp', input: { vendor: 'CoreBankingCo', appVersion: '11.4' } },
      { name: 'securityEffect', input: { value: 'none', why: 'it only reads a balance' } },
    ),
  ];
}

/** A person who answers what is asked and accepts what is put to them. */
function person(answers: Record<string, string> = {}): { ask: Ask; asked: string[] } {
  const asked: string[] = [];
  let provoking = false;

  return {
    asked,
    ask: (question) => {
      asked.push(`${question.kind}: ${question.text}`);
      if (question.kind === 'confirm') {
        return Promise.resolve('yes');
      }
      const text = question.text.toLowerCase();
      for (const [key, value] of Object.entries(answers)) {
        if (text.includes(key)) {
          return Promise.resolve(value);
        }
      }
      if (text.includes('not exist')) {
        provoking = true;
        return Promise.resolve(LIVE.missingRef);
      }
      return Promise.resolve(provoking ? LIVE.missingRef : 'go on');
    },
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'interfacer-generated-'));
}

const QUIET = { timeoutMs: 2_000, retries: 0 } as const;

// @covers generation.detectors-are-provoked generation.no-live-values-in-the-artifact
describe('a run that reaches the goal', () => {
  it('provokes the declared outcome, and writes a project with no live values in it', async () => {
    const root = scratch();
    const entries: Entry[] = [];
    const { ask } = person({
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
    });

    const generated = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url),
      decide: script(...reachTheGoal(), ...provokeAndInspect()),
      ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: (entry) => entries.push(entry),
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(generated.ending).toBe('returned');
    expect(generated.flow.steps.map((step) => step.kind)).toEqual([
      'open',
      'fillForm',
      'fillForm',
      'pressButton',
      'fillForm',
      'pressButton',
      'extract',
    ]);

    // The declared outcome was reached deliberately and its detector recorded
    // from the page that produced it — never guessed.
    expect(generated.outcomes).toEqual([
      {
        outcome: { id: 'account_not_found', description: 'no account with that reference' },
        verified: true,
      },
    ]);
    expect(generated.flow.outcomes.map((one) => one.id)).toEqual(['account_not_found']);

    // The values discovery ran on are held in memory and written nowhere: the
    // flow refers to inputs by accessor, so the artifact is parameterized by
    // construction and the record redacts what it was given.
    // Everything generation synthesized. `vendor/` is the DSL's own built
    // output, copied in byte for byte — it carries no data about this run, and
    // its own documentation happens to use an account reference as an example.
    const written = [...generated.files]
      .filter(([path]) => !path.startsWith('vendor/'))
      .map(([, contents]) => contents)
      .join('\n');
    const recorded = entries.map((entry) => JSON.stringify(entry)).join('\n');

    for (const value of [LIVE.username, LIVE.password, LIVE.accountRef, LIVE.missingRef]) {
      expect(written).not.toContain(value);
      expect(recorded).not.toContain(value);
    }

    // On disk, and complete.
    const files = readdirSync(join(root, 'src'));
    expect(files.sort()).toEqual([
      'cli.ts',
      'contract.ts',
      'flow.ts',
      'index.ts',
      'mcp.ts',
      'variant.ts',
    ]);
    expect(readFileSync(join(root, 'src', 'flow.ts'), 'utf8')).toContain('.returns(');
  }, 60_000);
});

// @covers tenant.entry-point-is-an-input
describe('the entry point the interview settled', () => {
  it('is a declared input of the capability, supplied rather than asked for again', async () => {
    // The interview records the entry point as its own answer, not as one of
    // the inputs a person lists — so a contract that names three inputs is the
    // normal case, and it is Interfacer's job to make the fourth. Without it
    // the model has no input to open by name: in a live run it inferred a host
    // from the allowlist and recorded `open(literal('http://127.0.0.1:4001/'))`
    // — a project that only ever works against the tenant it was recorded on,
    // and the wrong page, since the entry point declared was `/login`.
    const root = scratch();
    const { ask, asked } = person({
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
    });

    const generated = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url, {
        inputs: [
          { name: 'username', kind: 'text' },
          { name: 'password', kind: 'secret' },
          { name: 'accountRef', kind: 'text', description: 'account to look up' },
        ],
      }),
      // The same turns as a reaching run, minus the question about where to
      // start: the model does not have to ask for what the interview settled.
      decide: script(...reachTheGoal().slice(1), ...provokeAndInspect()),
      ask,
      browser,
      root,
      packageName: 'mybank-balance',
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(generated.ending).toBe('returned');

    // Declared, so the generated CLI takes a `--url` and one artifact serves
    // every tenant that differs only in where it lives.
    expect(readFileSync(join(root, 'src', 'contract.ts'), 'utf8')).toContain('url: text(');
    expect(readFileSync(join(root, 'src', 'flow.ts'), 'utf8')).toContain(".open(field('url')");

    // Nobody was asked for it: it is an answer already given, and re-asking a
    // settled answer is the second pass a rerun exists to avoid.
    expect(
      asked.filter((question) => /where does this start|value for url/i.test(question)),
    ).toEqual([]);
  }, 60_000);
});

// @covers variant.stamp-is-written variant.not-a-runtime-check
describe('the variant stamp', () => {
  it('is written from what the pages revealed and what the person confirmed', async () => {
    const root = scratch();
    const { ask, asked } = person({
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
    });

    // The stamp names the host the capability was commissioned against; the run
    // itself drives the fixture, because the entry point is an ordinary input.
    // That is the real case — somebody points the artifact at another host —
    // and it is why a host difference cannot be a signal.
    const generated = await generate({
      ...QUIET,
      contract: contract('https://mybank.invalid/'),
      decide: script(...reachTheGoal(), ...provokeAndInspect()),
      ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: () => undefined,
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(generated.variant).toEqual({
      capability: 'checkAccountBalance',
      vendor: 'CoreBankingCo',
      appVersion: '11.4',
      recordedAgainst: 'mybank.invalid',
      recordedOn: '2026-09-01',
    });
    // Proposed by the model, confirmed by the person — on the same terms as the
    // allowlist. A model that settles it alone is authoring its own constraint.
    expect(asked.some((one) => one.startsWith('confirm: vendor'))).toBe(true);
    expect(readFileSync(join(root, 'src', 'variant.ts'), 'utf8')).toContain(
      "vendor: 'CoreBankingCo'",
    );

    // And the run reached the goal against a host the stamp does not name: the
    // stamp is a diagnosis, never a check. Nothing in the emitted project reads
    // it back to compare it with anything.
    expect(generated.ending).toBe('returned');
    const emitted = [...generated.files]
      .filter(([path]) => path.startsWith('src/'))
      .map(([, contents]) => contents)
      .join('\n');
    expect(emitted).toContain('variant');
    expect(emitted).not.toMatch(/recordedAgainst\s*[=!]==/);
  }, 60_000);

  it('is absent where nobody knows it, rather than guessed', async () => {
    const root = scratch();
    const { ask } = person({
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
    });

    const generated = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url),
      decide: script(
        ...reachTheGoal(),
        turn({ name: 'ask', input: { question: 'which does not exist?', for: 'accountRef' } }),
        turn({ name: 'outcome', input: { status: 'account_not_found', detector: NOT_FOUND } }),
        // The pages said nothing about who makes this or what it is running.
        turn({ name: 'stamp', input: {} }),
      ),
      ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: () => undefined,
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(generated.variant.vendor).toBeUndefined();
    expect(generated.variant.appVersion).toBeUndefined();
    expect(readFileSync(join(root, 'src', 'variant.ts'), 'utf8')).not.toContain('vendor');
  }, 60_000);
});

// @covers generation.detectors-are-provoked
describe('an outcome that cannot be reached', () => {
  it('is reported unverified rather than recorded as a guess', async () => {
    const root = scratch();
    const { ask } = person({
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
      'not exist': LIVE.accountRef,
    });

    const generated = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url),
      // The value it asks for does not provoke anything: the flow runs to the
      // end, and the state is never reached.
      decide: script(
        ...reachTheGoal(),
        turn({ name: 'ask', input: { question: 'which does not exist?', for: 'accountRef' } }),
      ),
      ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: () => undefined,
    });

    expect(generated.outcomes).toEqual([
      {
        outcome: { id: 'account_not_found', description: 'no account with that reference' },
        verified: false,
        why: 'the flow ran to the end with that value: the state was never reached',
      },
    ]);
    // Nothing was written for it. The arm existing while its condition never
    // matched would arrive at replay as a hard failure.
    expect(generated.flow.outcomes).toEqual([]);
    expect(readFileSync(join(root, 'src', 'flow.ts'), 'utf8')).not.toContain('.outcome(');
  }, 60_000);
});

// @covers generation.partial-flow-is-written
describe('a run that stops before the goal', () => {
  it('writes the partial flow, so a re-run continues from it', async () => {
    const root = scratch();
    const { ask } = person({
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
    });

    const generated = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url),
      decide: script(...reachTheGoal().slice(0, 7)),
      ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: () => undefined,
      maxTurns: 9,
    });

    expect(generated.ending).not.toBe('returned');
    expect(generated.flow.steps.length).toBeGreaterThan(0);

    const source = readFileSync(join(root, 'src', 'flow.ts'), 'utf8');
    expect(source).toContain('PARTIAL');
    // The comment says the words `.returns()`; what must be absent is the call.
    expect(source).not.toMatch(/\.returns\(answer/);
    // Every declared outcome is unverified: the run never got far enough to
    // provoke one, and saying so is the point.
    expect(generated.outcomes.every((one) => !one.verified)).toBe(true);
  }, 60_000);
});

// @covers agent.harness-holds-the-cap
describe('the discovery budget', () => {
  it('is raised by an approval interactively, and stops the run where nobody is asked', async () => {
    const root = scratch();
    const answers = {
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
    };

    // A ceiling one turn wide. Unattended, that is where the run ends.
    const unattended = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url, { budgetUsd: 0.0001 }),
      decide: script(...reachTheGoal()),
      browser,
      root,
      packageName: 'mybank-balance',
      record: () => undefined,
    });

    expect(unattended.ending).toBe('budget-exhausted');
    expect(readFileSync(join(root, 'src', 'flow.ts'), 'utf8')).toContain('PARTIAL');

    // With somebody to ask, reaching the cap is an approval rather than a
    // failure: approving raises the ceiling and the same session continues.
    const attended = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url, { budgetUsd: 0.0001 }),
      decide: script(...reachTheGoal(), ...provokeAndInspect()),
      ask: person(answers).ask,
      browser,
      root: scratch(),
      packageName: 'mybank-balance',
      record: () => undefined,
    });

    expect(attended.ending).toBe('returned');
    expect(attended.costUsd).toBeGreaterThan(0.0001);
  }, 90_000);
});

// @covers generation.seeded-discovery-verifies
describe('a rerun in a location that already holds a project', () => {
  it("reads the project's own flow, verifies it, and re-provokes every outcome", async () => {
    const root = scratch();
    const answers = {
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      // A seeded run asks for the inputs by name before it verifies anything.
      'value for url': bundle.fixtures.clean.url,
      'value for username': LIVE.username,
      'value for password': LIVE.password,
      'value for accountref': LIVE.accountRef,
      password: LIVE.password,
      'which account': LIVE.accountRef,
    };

    const first = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url),
      decide: script(...reachTheGoal(), ...provokeAndInspect()),
      ask: person(answers).ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: () => undefined,
    });

    expect(first.ending).toBe('returned');
    expect(first.seed).toBeUndefined();

    // Run it again in the same location. The steps come off the disk, and the
    // model is given nothing to discover with: if the seed were not verified
    // and kept, this run could not reach the goal at all.
    const again = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url),
      decide: script(...provokeAndInspect()),
      ask: person(answers).ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: () => undefined,
    });

    // Every call in the module was read: the steps, the `.outcome()` that is
    // deliberately dropped rather than carried, and the `.returns()`.
    expect(again.seed?.read).toBe(first.flow.steps.length + first.flow.outcomes.length + 1);
    expect(again.seed?.stoppedAt).toBeUndefined();
    expect(again.ending).toBe('returned');
    expect(again.flow.steps.map((step) => step.id)).toEqual(
      first.flow.steps.map((step) => step.id),
    );

    // The sibling's detector was not carried across. Wording is precisely what
    // differs between tenants, so it is provoked again against this application
    // or it is not there at all.
    expect(again.outcomes).toEqual([
      {
        outcome: { id: 'account_not_found', description: 'no account with that reference' },
        verified: true,
      },
    ]);
    expect(again.flow.outcomes.map((one) => one.id)).toEqual(['account_not_found']);
    expect(readFileSync(join(root, 'src', 'flow.ts'), 'utf8')).toContain('.outcome(');
  }, 90_000);
});

describe('a seeded run', () => {
  /** A flow recorded elsewhere, as a sibling project would carry it. */
  function seed(url: string, username: readonly unknown[]) {
    return new Flow<typeof SEED_INPUT, unknown>({ id: 'checkAccountBalance', input: SEED_INPUT })
      .open(literal(url), { id: 'login.open' })
      .fillForm(username as never, field('username'), { id: 'login.username' })
      .fillForm(PASSWORD as never, field('password'), { id: 'login.password' })
      .pressButton(SIGN_IN as never, { id: 'login.submit' });
  }

  it('keeps the steps that still resolve, and re-discovers the ones that do not', async () => {
    // A step naming a control this tenant does not have. Everything before it
    // works; it and everything after are not to be trusted.
    const broken = seed(bundle.fixtures.clean.url, [{ by: 'label', text: 'Member number' }]);

    const discovery = await discover(broken, {
      ...QUIET,
      task: 'sign in',
      input: { username: LIVE.username, password: makeSecret(LIVE.password) },
      decide: script(
        turn({
          name: 'fillForm',
          input: { target: USERNAME, value: { from: 'input', name: 'username' } },
        }),
        turn({
          name: 'fillForm',
          input: { target: PASSWORD, value: { from: 'input', name: 'password' } },
        }),
        turn({ name: 'pressButton', input: { target: SIGN_IN } }),
      ),
      browser,
      record: () => undefined,
      verifySeed: true,
      maxTurns: 3,
    });

    // What the new application accepted was kept; the rest was retracted and
    // re-discovered. Copying a project and editing the URL keeps a sibling's
    // steps unchecked — copying it and running Interfacer keeps only what works.
    expect(discovery.seeded?.kept.map((step) => step.id)).toEqual(['login.open']);
    expect(discovery.seeded?.stoppedAt?.id).toBe('login.username');
    expect(broken.steps.map((step) => step.id)).toEqual([
      'login.open',
      'fillForm:label="Username"',
      'fillForm:label="Password"',
      'pressButton:role=button name="Sign in"',
    ]);
  }, 60_000);

  it('keeps every step where the tenant only looks different', async () => {
    // `rebranded` is `clean` restyled and reworded, so a chain that names the
    // wording it was recorded against *and* the structure behind it survives.
    const carried = seed(bundle.fixtures.rebranded.url, [
      { by: 'label', text: 'Username' },
      { by: 'css', selector: 'input[name="username"]' },
    ]);

    const discovery = await discover(carried, {
      ...QUIET,
      task: 'sign in',
      input: { username: LIVE.username, password: makeSecret(LIVE.password) },
      decide: script(),
      browser,
      record: () => undefined,
      verifySeed: true,
      maxTurns: 1,
    });

    expect(discovery.seeded?.stoppedAt).toBeUndefined();
    expect(discovery.seeded?.kept).toHaveLength(4);
    expect(carried.steps).toHaveLength(4);
  }, 60_000);
});

// @covers record.attachments-on-undetected-outcome
describe('an outcome reached but not detected', () => {
  it('captures the screen a person will have to write the detector against', async () => {
    const root = scratch();
    const dir = mkdtempSync(join(tmpdir(), 'interfacer-undetected-'));
    const entries: Entry[] = [];
    const { ask } = person({
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
      'not exist': 'ACC-9999',
    });

    const generated = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url),
      decide: script(
        ...reachTheGoal(),
        turn({ name: 'ask', input: { question: 'which does not exist?', for: 'accountRef' } }),
        // The value reaches the state; the model then never names a detector
        // for it, which is the case a person has to finish by hand.
        turn({ name: 'snapshot', input: {} }),
      ),
      ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: (entry) => entries.push(entry),
      attachmentDir: dir,
      turnsPerPhase: 1,
    });

    expect(generated.outcomes[0]?.verified).toBe(false);
    expect(generated.outcomes[0]?.why).toBe('the state was reached but no detector matched it');

    const undetected = entries.find((entry) => entry.kind === 'outcome.undetected');
    expect(undetected?.attachments?.map((one) => one.kind).sort()).toEqual(['dom', 'screenshot']);
    expect(undetected?.attachments?.every((one) => one.trigger === 'undetected-outcome')).toBe(
      true,
    );

    // And the run says it failed at the one thing it was for, rather than
    // reporting the success of having completed without throwing.
    expect(
      entries.some(
        (entry) =>
          entry.kind === 'run.finished' &&
          entry.status.ending === 'failure' &&
          entry.status.category === 'undetected-outcome',
      ),
    ).toBe(true);
  }, 60_000);
});

describe('a malformed tool argument while provoking', () => {
  it('is handed back to the model instead of taking the session down', async () => {
    // A live run died here: the model named a value source the tool does not
    // know, `answerFor` threw `ToolArgumentError` from outside any catch, and
    // the exception went through `generate` to the top of the process. Every
    // phase before it — a completed discovery and a provoked outcome — was lost
    // with it. The same class of mistake is ordinary information in `loop.ts`.
    const root = scratch();
    const { ask } = person({
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
      'not exist': 'ACC-9999',
    });

    const generated = await generate({
      ...QUIET,
      contract: contract(bundle.fixtures.clean.url),
      decide: script(
        ...reachTheGoal(),
        turn({ name: 'ask', input: { question: 'which does not exist?', for: 'accountRef' } }),
        // `values` names no source the tool knows.
        turn({
          name: 'outcome',
          input: { status: 'account_not_found', detector: NOT_FOUND, values: { ref: {} } },
        }),
        // Corrected on the next turn, which is only possible if the first did
        // not end the process.
        turn({
          name: 'outcome',
          input: {
            status: 'account_not_found',
            detector: NOT_FOUND,
            values: { ref: { from: 'input', name: 'accountRef' } },
          },
        }),
        turn({ name: 'stamp', input: {} }),
      ),
      ask,
      browser,
      root,
      packageName: 'mybank-balance',
      record: () => undefined,
    });

    expect(generated.outcomes[0]?.verified).toBe(true);
    expect(readFileSync(join(root, 'src', 'flow.ts'), 'utf8')).toContain('.outcome(');
  }, 60_000);
});

describe('a phase that throws after discovery has succeeded', () => {
  it('still leaves the project on disk, because the work is already done', async () => {
    // `writeProject` is the last statement of `generate`, so anything thrown by
    // provocation or inspection used to discard a completed discovery — the one
    // expensive, unrepeatable part of a run. The design's promise is that the
    // flow is written whatever stops the run; that has to hold here too.
    const root = scratch();
    const { ask } = person({
      'where does this start': bundle.fixtures.clean.url,
      'sign in as': LIVE.username,
      password: LIVE.password,
      'which account': LIVE.accountRef,
      'not exist': 'ACC-9999',
    });

    // Built once: a script rebuilt per call would replay its first turn forever.
    const discovery = script(...reachTheGoal());
    let turns = 0;
    const failsAfterDiscovery: Decide = (state, tools) => {
      turns += 1;
      // Every turn discovery needs, and then nothing but an exception — so what
      // throws is a phase that runs *after* discovery has already succeeded.
      return turns > reachTheGoal().length
        ? Promise.reject(new Error('the provider fell over'))
        : discovery(state, tools);
    };

    await expect(
      generate({
        ...QUIET,
        contract: contract(bundle.fixtures.clean.url),
        decide: failsAfterDiscovery,
        ask,
        browser,
        root,
        packageName: 'mybank-balance',
        record: () => undefined,
      }),
    ).rejects.toThrow('the provider fell over');

    // The failure is still a failure — but the flow discovery proved survives it.
    const written = readFileSync(join(root, 'src', 'flow.ts'), 'utf8');
    expect(written).toContain('.pressButton(');
    expect(written).toContain('.extract(');
  }, 60_000);
});
