import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startAll, type FixtureBundle } from '@interfacer/fixtures';
import {
  DEFAULT_EFFECTS,
  fields,
  Flow,
  makeSecret,
  runFlow,
  secret,
  text,
  type Entry,
  type Infer,
  type Usage,
} from '@interfacer/dsl';
import { chromium, type Browser } from 'playwright';
import {
  discover,
  TOOLS,
  type Decide,
  type DiscoveryState,
  type Question,
  type Turn,
} from 'interfacer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The loop, driven by a scripted model.
 *
 * These test Interfacer's loop rather than the model: step appending, cost
 * accounting, the stall guard, budget exhaustion and the between-turns allowlist
 * check. A scripted `decide` is a fake rather than a mock — it returns
 * predetermined tool calls and nothing asserts how it was called — and it is the
 * only practical way to test pathological behaviour, because a live model will
 * not produce it on demand.
 */

let bundle: FixtureBundle;
let browser: Browser;

beforeAll(async () => {
  [bundle, browser] = await Promise.all([startAll(), chromium.launch()]);
}, 60_000);

afterAll(async () => {
  await Promise.all([bundle.closeAll(), browser.close()]);
});

const inputFields = fields({
  url: text({ description: 'entry point' }),
  username: text(),
  password: secret(),
  accountRef: text(),
});

function liveValues(): Infer<typeof inputFields> {
  return {
    url: bundle.fixtures.clean.url,
    username: 'teller1',
    password: makeSecret('s3cret-teller'),
    accountRef: 'ACC-1001',
  };
}

const USAGE: Usage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadInputTokens: 9_000,
  cacheCreationInputTokens: 0,
};

let nextId = 0;

/** One turn's worth of tool calls, in the shape the seam hands back. */
function turn(...calls: readonly { name: string; input: Record<string, unknown> }[]): Turn {
  return {
    text: '',
    usage: USAGE,
    calls: calls.map((call) => ({ id: `call_${String(nextId++)}`, ...call })),
  };
}

/** A model that says exactly this, and then nothing it has not been told to say. */
function script(...turns: readonly Turn[]): { decide: Decide; seen: DiscoveryState[] } {
  const seen: DiscoveryState[] = [];
  let index = 0;

  return {
    seen,
    decide: (state) => {
      seen.push(state);
      const next = turns[index++] ?? turn({ name: 'snapshot', input: {} });
      return Promise.resolve(next);
    },
  };
}

const SIGN_IN = [
  { by: 'role', role: 'button', name: 'Sign in' },
  { by: 'css', selector: 'button[type="submit"]' },
];
const USERNAME = [{ by: 'label', text: 'Username' }];
const PASSWORD = [{ by: 'label', text: 'Password' }];
const ACCOUNT = [{ by: 'label', text: 'Account number' }];
const LOOK_UP = [{ by: 'role', role: 'button', name: 'Look up' }];
const BALANCE = [{ by: 'css', selector: '#balance-value' }];

/** The turns that reach a balance, which several tests start from. */
function signIn(): readonly Turn[] {
  return [
    turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
    turn({
      name: 'fillForm',
      input: { target: USERNAME, value: { from: 'input', name: 'username' } },
    }),
    turn({
      name: 'fillForm',
      input: { target: PASSWORD, value: { from: 'input', name: 'password' } },
    }),
    turn({ name: 'pressButton', input: { target: SIGN_IN } }),
  ];
}

function lookUp(): readonly Turn[] {
  return [
    turn({
      name: 'fillForm',
      input: { target: ACCOUNT, value: { from: 'input', name: 'accountRef' } },
    }),
    turn({ name: 'pressButton', input: { target: LOOK_UP } }),
  ];
}

function capability() {
  return new Flow({ id: 'checkAccountBalance', input: inputFields });
}

const QUIET = { record: () => undefined, timeoutMs: 1_500 } as const;

// @covers session.human-channel-is-prose
describe('a question the model asks', () => {
  it('reaches the person in prose, and their words come back', async () => {
    const flow = capability();
    const { decide, seen } = script(
      turn({ name: 'ask', input: { question: 'which account should I look up?' } }),
      turn({ name: 'snapshot', input: {} }),
    );

    const asked: string[] = [];
    await discover(flow, {
      ...QUIET,
      task: 'read a balance',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 2,
      ask: (question) => {
        asked.push(`${question.kind}: ${question.text}`);
        return Promise.resolve('use ACC-1001, it is the one with a balance');
      },
    });

    expect(asked).toEqual(['open: which account should I look up?']);
    // The answer is whatever the person says. A pause resolver could not carry
    // it: an `operator` answer is the literal 'done'.
    const results = seen[1]?.transcript.find((exchange) => exchange.kind === 'results');
    expect(results?.kind === 'results' && results.results[0]?.detail).toBe(
      'use ACC-1001, it is the one with a balance',
    );
    // Held for the run and written nowhere: it is not a step, so the artifact
    // never sees it.
    expect(flow.steps).toHaveLength(0);
  });

  it('is put as a credential question where it asks for a secret, and the answer goes no further', async () => {
    // Two halves of the same rule: a live value for a `secret()` input is a
    // real credential. The channel is told, so a reader that echoes does not
    // put it on the screen; and the tool result carries only the binding, so it
    // does not go to the provider and sit in the transcript every turn after.
    // The model never needs it — it fills the field by naming the input, and
    // the engine is the only thing that reveals a secret.
    const flow = capability();
    const { decide, seen } = script(
      turn({ name: 'ask', input: { question: 'and the password?', for: 'password' } }),
      turn({ name: 'snapshot', input: {} }),
    );

    const asked: Question[] = [];
    await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 2,
      ask: (question) => {
        asked.push(question);
        return Promise.resolve('s3cret-teller');
      },
    });

    expect(asked[0]?.secret).toBe(true);

    const results = seen[1]?.transcript.find((exchange) => exchange.kind === 'results');
    const detail = results?.kind === 'results' ? (results.results[0]?.detail ?? '') : '';
    expect(detail).toBe('bound to password');
    expect(JSON.stringify(seen[1])).not.toContain('s3cret-teller');
  });

  it('says so when there is nobody in the session', async () => {
    const flow = capability();
    const { decide, seen } = script(
      turn({ name: 'ask', input: { question: 'which account should I look up?' } }),
      turn({ name: 'snapshot', input: {} }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'read a balance',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 2,
    });

    const results = seen[1]?.transcript.find((exchange) => exchange.kind === 'results');
    expect(results?.kind === 'results' && results.results[0]?.detail).toContain(
      'there is nobody to ask',
    );
  });
});

describe('a step that reads an input nobody has supplied yet', () => {
  it('tells the model which input it is and to ask for it, and the run goes on', async () => {
    // The live-value map starts empty and fills as the model asks, so this is
    // an ordinary state rather than a caller's mistake — and in a live session
    // the model went straight to `fillForm`, got back `Cannot read properties
    // of undefined (reading 'reveal')`, tried the next field, and stalled with
    // a one-step flow. A tool result naming neither the input nor the remedy is
    // not information the model can act on.
    const flow = capability();
    const { decide, seen } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      turn({
        name: 'fillForm',
        input: { target: USERNAME, value: { from: 'input', name: 'username' } },
      }),
    );

    const found = await discover(flow, {
      ...QUIET,
      task: 'sign in',
      // Only the entry point is known: the rest is what the model has to ask for.
      input: { url: bundle.fixtures.clean.url } as Infer<typeof inputFields>,
      decide,
      browser,
      maxTurns: 3,
      retries: 0,
    });

    const results = seen
      .at(-1)
      ?.transcript.filter((exchange) => exchange.kind === 'results')
      .at(-1);
    const detail = results?.kind === 'results' ? (results.results[0]?.detail ?? '') : '';

    expect(detail).toContain('input "username"');
    expect(detail).toContain('ask');
    // Nothing was appended, and the run is still going: a step that fails is
    // information, not an ending.
    expect(flow.steps.map((step) => step.kind)).toEqual(['open']);
    expect(found.ending).toBe('turn-limit');
  });
});

describe('a discovery run told where to put its evidence', () => {
  it('writes the attachments a hard failure triggers, masked by what the contract declared', async () => {
    // A discovery run is the one that cannot be repeated cheaply, and until the
    // CLI took `--attachments` there was no way to keep a picture of what the
    // model was looking at when a step failed — the record said only that it
    // had skipped. The triggers are the engine's own three; this exercises the
    // one a discovery run meets most.
    const dir = mkdtempSync(join(tmpdir(), 'interfacer-evidence-'));
    // What the capability observes decides what may be kept: at PII the
    // screenshot is masked and the DOM is stripped of values, at capture time.
    const flow = new Flow({
      id: 'checkAccountBalance',
      input: inputFields,
      effects: { ...DEFAULT_EFFECTS, dataClasses: ['PII'] },
    });
    const { decide } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      turn({ name: 'checkpoint', input: { target: [{ by: 'text', text: 'not on this page' }] } }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 3,
      retries: 0,
      attachmentDir: dir,
    });

    // One directory per run, and a file per trigger within it, so a directory
    // pointed at twice does not interleave two runs' evidence.
    const runs = readdirSync(dir);
    expect(runs).toHaveLength(1);

    const inRun = join(dir, runs[0] ?? '');
    const written = readdirSync(inRun);

    expect(written.some((name) => name.endsWith('.png'))).toBe(true);
    expect(written.some((name) => name.endsWith('.html'))).toBe(true);
    expect(written.every((name) => name.includes('hard-failure'))).toBe(true);

    // Structure-only, which the design draws precisely: the attributes that
    // *name* a control are kept and every text node and value-bearing attribute
    // is dropped. So the field is still identifiable — and what was typed into
    // it is not there to be identified.
    const dom = readFileSync(
      join(inRun, written.find((name) => name.endsWith('.html')) ?? ''),
      'utf8',
    );
    expect(dom).toContain('data-testid="username"');
    expect(dom).toContain('for="username"');
    expect(dom).not.toContain('teller1');
    expect(dom).not.toContain('s3cret-teller');
  });
});

// @covers target.preference-order
describe('a target that describes where a control sits rather than what it is', () => {
  it('is refused, and the model is told to name the element instead', async () => {
    // The design excludes positional paths and generated class names outright:
    // they encode incidental structure and break on any re-render. Nothing
    // enforced it, and a live run recorded `dl dd:nth-of-type(1..4)` for four
    // extracts on the *clean* fixture — a capability that silently reads the
    // wrong field the day a row is added above.
    const flow = capability();
    const { decide, seen } = script(
      ...signIn(),
      ...lookUp(),
      turn({
        name: 'extract',
        input: {
          name: 'balance',
          target: [{ by: 'css', selector: 'dl dd:nth-of-type(4)' }],
          parse: 'money',
        },
      }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'read a balance',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 8,
      retries: 0,
    });

    const results = seen
      .at(-1)
      ?.transcript.filter((exchange) => exchange.kind === 'results')
      .at(-1);
    const detail = results?.kind === 'results' ? (results.results[0]?.detail ?? '') : '';

    expect(detail).toContain('positional');
    // Nothing was appended: a refused target must not reach the artifact, and
    // the extract is not among the recorded steps.
    expect(flow.steps.map((step) => step.kind)).not.toContain('extract');
  });

  it('is accepted where the page gives the element a name to be found by', async () => {
    // The guard: the rule is about incidental structure, not about css. The
    // same value, targeted by the test id the page carries, is recorded.
    const flow = capability();
    const { decide } = script(
      ...signIn(),
      ...lookUp(),
      turn({
        name: 'extract',
        input: {
          name: 'balance',
          target: [{ by: 'css', selector: '[data-testid="balance"]' }],
          parse: 'money',
        },
      }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'read a balance',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 8,
      retries: 0,
    });

    expect(flow.steps.map((step) => step.kind)).toContain('extract');
  });
});

// @covers agent.acting-and-recording-are-one
describe('what a tool call does', () => {
  it('appends the step it just performed, in order', async () => {
    const flow = capability();
    const { decide } = script(...signIn());

    const found = await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 4,
    });

    // The flow accumulates as a by-product of doing the task. There is no
    // separate "write down what you did" step to get wrong.
    expect(flow.steps.map((step) => step.kind)).toEqual([
      'open',
      'fillForm',
      'fillForm',
      'pressButton',
    ]);
    expect(found.ending).toBe('turn-limit');
  });

  it('keeps nothing when the application refuses the step', async () => {
    const flow = capability();
    const { decide } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      turn({
        name: 'fillForm',
        input: {
          target: [{ by: 'label', text: 'A field that is not on this page' }],
          value: { from: 'input', name: 'username' },
        },
      }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 2,
      retries: 0,
    });

    // A step that fails is information the model acts on, not something the
    // artifact keeps.
    expect(flow.steps.map((step) => step.kind)).toEqual(['open']);
  });

  it('tells the model what the engine observed, so it can try something else', async () => {
    const flow = capability();
    const { decide, seen } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      turn({
        name: 'fillForm',
        input: {
          target: [{ by: 'label', text: 'Nope' }],
          value: { from: 'input', name: 'username' },
        },
      }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 3,
      retries: 0,
    });

    const results = seen
      .at(-1)
      ?.transcript.filter((exchange) => exchange.kind === 'results')
      .at(-1);

    expect(results?.kind === 'results' && results.results[0]?.ok).toBe(false);
    expect(results?.kind === 'results' && results.results[0]?.detail).toMatch(/label="Nope"/);
  });
});

// @covers agent.sees-the-accessibility-tree agent.screenshot-is-never-a-target agent.value-nodes-are-identified
describe('what the model is given', () => {
  it('is the accessibility tree, in the vocabulary targets are written in', async () => {
    const flow = capability();
    const { decide, seen } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 2,
    });

    // A model shown `button "Sign in"` proposes byRole('button', 'Sign in'). A
    // model shown a wall of divs proposes a brittle CSS path, because that is
    // all it was given to work with.
    const tree = seen.at(-1)?.observation.tree ?? '';

    expect(tree).toMatch(/button "Sign in"/);
    expect(tree).toMatch(/textbox "Username"/);
    expect(tree).not.toMatch(/<div/);
  });

  it('names what identifies a value-bearing node, which the tree cannot', async () => {
    // The tree is a screen reader's view, and a value node — a `dd`, a `td`, an
    // `input` — has no role and no accessible name to be found by. So the tree
    // shows the balance and nothing to target it with, and a model asked to
    // extract it has only a positional path left, which targeting excludes. The
    // page does carry a stable name for it; this is what puts that in front of
    // the model, as attribute *names* rather than values.
    const flow = capability();
    const { decide, seen } = script(...signIn(), ...lookUp());

    await discover(flow, {
      ...QUIET,
      task: 'read a balance',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 7,
    });

    const observation = seen.at(-1)?.observation;

    expect(observation?.values ?? '').toContain('data-testid="balance"');
    // The half that explains why it is needed at all.
    expect(observation?.tree ?? '').not.toContain('data-testid');
  });

  it('gives a screenshot as a second observation that appends nothing', async () => {
    const flow = capability();
    const { decide, seen } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      turn({ name: 'screenshot', input: {} }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'look',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 3,
    });

    // It informs a decision and can never be a target: nothing durable is
    // recordable from a coordinate, so a control located by eye still has to be
    // committed as an element identified in the tree.
    expect(flow.steps.map((step) => step.kind)).toEqual(['open']);

    const results = seen.at(-1)?.transcript.at(-1);
    expect(results?.kind === 'results' && results.results[0]?.detail).toMatch(/identify anything/);
  });

  it('degrades usefully where the application gives it little to work with', async () => {
    // `legacy` is the shape most back-office systems actually have: table
    // layout, no `<label for>`, no test ids. The tree it yields is poor — and a
    // poor tree is still a tree, which is the second reason the design gives for
    // showing one rather than markup.
    const flow = new Flow({ id: 'onLegacy', input: inputFields });
    const { decide, seen } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: { ...liveValues(), url: bundle.fixtures.legacy.url },
      decide,
      browser,
      maxTurns: 2,
    });

    const tree = seen.at(-1)?.observation.tree ?? '';
    const markup = await (await fetch(`${bundle.fixtures.legacy.url}/login`)).text();

    // What survives: the submit button keeps a role and a name, because
    // `<input type="submit">` takes its accessible name from `value`.
    expect(tree).toMatch(/button "Sign in"/);
    // What does not: the field names are in table cells rather than labels, so
    // they arrive as text beside an unnamed textbox rather than as its name.
    expect(tree).not.toMatch(/textbox "Username"/);
    expect(tree).toMatch(/Username/);
    // And it is smaller than the markup behind it, which is the other half of
    // "degrades better": less to read, and none of it layout.
    expect(tree.length).toBeLessThan(markup.length);
    expect(tree).not.toMatch(/<table|<td|font-family/);
  });

  it('gives the model what a picture of the page could not', async () => {
    // `hostile`'s sign-in button reads "Sign in" and is announced as "Submit
    // credentials". A model working from pixels proposes the visible words and
    // finds nothing; a model shown the tree proposes the name that resolves.
    const flow = new Flow({ id: 'onHostile', input: inputFields });
    const { decide, seen } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      turn({
        name: 'pressButton',
        input: { target: [{ by: 'role', role: 'button', name: 'Submit credentials' }] },
      }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: { ...liveValues(), url: bundle.fixtures.hostile.url },
      decide,
      browser,
      maxTurns: 3,
      retries: 0,
    });

    const tree = seen[1]?.observation.tree ?? '';

    // Both halves in one line of the tree: the name that resolves, and the words
    // actually on the screen. They differ, and the tree is the only observation
    // in which that is visible at all.
    expect(tree).toMatch(/button "Submit credentials": Sign in/);
    expect(tree).not.toMatch(/button "Sign in"/);
    expect(flow.steps.map((step) => step.kind)).toEqual(['open', 'pressButton']);
  });

  it('offers no tool that takes a coordinate', () => {
    const surface = JSON.stringify(TOOLS);

    expect(surface).not.toMatch(/"x"|"y"|coordinate|clientX/i);
  });
});

// @covers agent.model-never-writes-typescript
describe('what the model may put in the artifact', () => {
  it('is only what the vocabulary names', async () => {
    const flow = capability();
    const { decide } = script(
      ...signIn(),
      // A tool that does not exist, and a verb that is not in the vocabulary.
      turn({ name: 'evaluate', input: { script: 'page.evaluate(() => 1)' } }),
      turn({ name: 'appendRaw', input: { source: '.fillForm(css("#x"), () => "y")' } }),
    );

    await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 6,
    });

    // The model calls tools; Interfacer emits the source. There is no path from
    // a string the model wrote to a step in the artifact.
    expect(flow.steps).toHaveLength(4);
    expect(TOOLS.map((tool) => tool.name)).not.toContain('evaluate');
  });
});

// @covers agent.harness-holds-the-cap
describe('the budget', () => {
  it('is told to the model, and enforced by the harness whatever the model does', async () => {
    const flow = capability();
    // A model that ignores the ceiling entirely: it goes on proposing work.
    const { decide, seen } = script(...signIn(), ...lookUp());

    // One turn of this script costs a fraction of a cent, so the cap is set
    // where the third turn crosses it.
    const found = await discover(flow, {
      ...QUIET,
      task: 'read a balance',
      input: liveValues(),
      decide,
      browser,
      budgetUsd: 0.02,
      maxTurns: 20,
    });

    expect(found.ending).toBe('budget-exhausted');
    expect(found.costUsd).toBeGreaterThanOrEqual(0.02);
    // Advisory, and only advisory: the model was told the ceiling and the
    // ceiling was not what stopped it obeying.
    expect(seen[0]?.budget.capUsd).toBe(0.02);
    expect(seen.at(-1)?.budget.spentUsd).toBeGreaterThan(0);
  });

  it('counts cached and uncached input at their own rates', async () => {
    const flow = capability();
    const { decide } = script(turn({ name: 'snapshot', input: {} }));

    const found = await discover(flow, {
      ...QUIET,
      task: 'look',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 1,
    });

    // Discovery resends history constantly, so cache reads are most of the
    // input and an order of magnitude cheaper. One turn of USAGE at Opus 5's
    // published rates: 1k fresh in, 9k cached in, 200 out.
    const expected = (1_000 * 5 + 9_000 * 0.5 + 200 * 25) / 1_000_000;

    expect(found.spend.cacheReadInputTokens).toBe(9_000);
    expect(found.costUsd).toBeCloseTo(expected, 10);
  });

  it('accounts for nothing it cannot price, rather than reading it as free', async () => {
    const flow = capability();
    const { decide } = script(turn({ name: 'snapshot', input: {} }));

    const found = await discover(flow, {
      ...QUIET,
      task: 'look',
      input: liveValues(),
      decide,
      browser,
      model: 'some-model-nobody-published-rates-for',
      maxTurns: 1,
    });

    // The tokens are still counted; only the money is unknown. A budget that
    // silently reads as unspent would be the same failure as a default nobody
    // chose, so the tokens stay visible.
    expect(found.spend.inputTokens).toBe(1_000);
    expect(found.costUsd).toBe(0);
  });
});

// @covers agent.stall-guard-ends-the-run
describe('a run that stops changing the page', () => {
  it('ends, whatever budget remains, and keeps the partial flow', async () => {
    const flow = capability();
    // Signs in, then looks at the same page over and over.
    const { decide } = script(...signIn());

    const found = await discover(flow, {
      ...QUIET,
      task: 'read a balance',
      input: liveValues(),
      decide,
      browser,
      budgetUsd: 1_000,
      maxTurns: 40,
      stallTurns: 3,
    });

    // An agent retrying the same thing should not spend the rest of the ceiling
    // doing it.
    expect(found.ending).toBe('stalled');
    expect(found.costUsd).toBeLessThan(1_000);
    // The partial flow is what a later run continues from, so it survives the
    // ending that stopped it.
    expect(flow.steps.map((step) => step.kind)).toEqual([
      'open',
      'fillForm',
      'fillForm',
      'pressButton',
    ]);
  });

  it('does not end a run that is looking before it acts', async () => {
    const flow = capability();
    const { decide } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      // Three observations in a row change nothing, and are not a stall while
      // the run goes on to act.
      turn({ name: 'snapshot', input: {} }),
      turn({ name: 'screenshot', input: {} }),
      turn({
        name: 'fillForm',
        input: { target: USERNAME, value: { from: 'input', name: 'username' } },
      }),
    );

    const found = await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 4,
      stallTurns: 3,
    });

    expect(found.ending).toBe('turn-limit');
    expect(flow.steps.map((step) => step.kind)).toEqual(['open', 'fillForm']);
  });
});

describe('a provider that never finishes', () => {
  it('is terminated by the turn bound, which costs nothing to reach', async () => {
    const flow = capability();
    // A step is appended every turn, so the stall guard never fires — appending
    // is what resets it. Reporting no usage means the budget never fires
    // either. Something still has to end the run.
    //
    // It checkpoints rather than navigating: `open` now takes only an address
    // the contract declares, so a model cannot spin by inventing a new URL per
    // turn — which is the point of that rule, and leaves the turn bound as the
    // thing under test here.
    let n = 0;
    const decide: Decide = () => {
      n += 1;
      return Promise.resolve({
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        calls: [
          n === 1
            ? {
                id: 'loop_open',
                name: 'open',
                input: { url: { from: 'input', name: 'url' } },
              }
            : {
                id: `loop_${String(n)}`,
                name: 'checkpoint',
                input: { target: [{ by: 'label', text: 'Username' }] },
              },
        ],
      });
    };

    const found = await discover(flow, {
      ...QUIET,
      task: 'go forever',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 5,
      budgetUsd: 100,
    });

    expect(found.ending).toBe('turn-limit');
    expect(found.turns).toBe(5);
  });
});

// @covers allowlist.backstops-prompt-injection
describe('a navigation the page asked for', () => {
  it('is refused where it leaves the allowlist, and the run carries on', async () => {
    const flow = capability();
    // Page content is untrusted input: whatever the model reads may contain
    // instructions, and this is the model having followed one.
    const { decide, seen } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      turn({
        name: 'open',
        input: { url: { from: 'literal', value: 'http://somewhere-else.invalid/' } },
      }),
      turn({
        name: 'fillForm',
        input: { target: USERNAME, value: { from: 'input', name: 'username' } },
      }),
    );

    const found = await discover(flow, {
      ...QUIET,
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 4,
      retries: 0,
    });

    // The allowlist is what bounds the consequence of an injection succeeding:
    // the navigation never happens, nothing is appended, and the run goes on.
    expect(flow.steps.map((step) => step.kind)).toEqual(['open', 'fillForm']);
    expect(found.ending).toBe('turn-limit');

    const refusal = seen
      .at(-1)
      ?.transcript.filter((exchange) => exchange.kind === 'results')
      .at(1);

    expect(refusal?.kind === 'results' && refusal.results[0]?.ok).toBe(false);
  });
});

// @covers components.one-engine-two-callers
describe('the flow discovery produced', () => {
  it('replays with no model attached, through the same engine', async () => {
    const flow = capability();
    const { decide } = script(
      ...signIn(),
      ...lookUp(),
      turn({
        name: 'extract',
        input: { name: 'balance', target: BALANCE, parse: 'money' },
      }),
      turn({
        name: 'returns',
        input: { status: 'ok', values: { balance: 'balance' } },
      }),
    );

    const discovered = await discover(flow, {
      ...QUIET,
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 10,
    });

    expect(discovered.ending).toBe('returned');

    // The claim in one assertion: what the model drove step by step is a flow
    // the engine walks start to finish, with nothing in the loop. "It worked
    // during discovery" is a claim about replay rather than about a prototype.
    const replayed = await runFlow(flow, liveValues(), { ...QUIET, browser });

    expect(replayed).toEqual({ status: 'ok', balance: 1250.75 });
  });
});

// @covers agent.acting-and-recording-are-one
describe('the run record a discovery writes', () => {
  it('carries a model turn beside the step it produced', async () => {
    const entries: Entry[] = [];
    const flow = capability();
    const { decide } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
    );

    await discover(flow, {
      task: 'sign in',
      input: liveValues(),
      decide,
      browser,
      timeoutMs: 1_500,
      maxTurns: 2,
      record: (entry) => entries.push(entry),
    });

    const turnEntry = entries.find((entry) => entry.kind === 'model.turn');

    expect(turnEntry).toMatchObject({ tool: 'open', phase: 'discovery' });
    expect(turnEntry?.kind === 'model.turn' && turnEntry.usage.cacheReadInputTokens).toBe(9_000);
    // The step that turn produced is in the same record, under the same run.
    expect(entries.some((entry) => entry.kind === 'step.finished')).toBe(true);
  });
});

// @covers agent.turn-without-a-call-recovers
describe('a turn that calls no tool', () => {
  it('does not derail the session it lands in the middle of', async () => {
    // The failure this guards: the loop had nothing to report for such a turn,
    // so it rendered an empty user message — which the provider rejects, and
    // which poisons every request built from the transcript afterwards. The run
    // died several turns later, at a message index nothing in the record
    // explained. Here the empty turn sits in the middle of a working script.
    const flow = capability();
    const { decide } = script(
      ...signIn(),
      turn(),
      ...lookUp(),
      turn({ name: 'extract', input: { name: 'balance', target: BALANCE, parse: 'money' } }),
      turn({ name: 'returns', input: { status: 'ok', values: { balance: 'balance' } } }),
    );

    const discovered = await discover(flow, {
      ...QUIET,
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 12,
    });

    expect(discovered.ending).toBe('returned');
  });

  it('is told what it failed to do, rather than being asked the same thing again', async () => {
    // Skipping the exchange would leave the next request byte-identical to the
    // one that produced nothing, so the model would produce it again and the
    // run would stall. What it gets back has to differ from what it last saw.
    const flow = capability();
    const { decide, seen } = script(turn(), turn({ name: 'snapshot', input: {} }));

    await discover(flow, {
      ...QUIET,
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 3,
    });

    const after = seen.at(-1)?.transcript ?? [];
    const said = after.filter((exchange) => exchange.kind === 'nudge');
    expect(said).toHaveLength(1);
    expect(said[0]?.kind === 'nudge' ? said[0].text : '').toContain('called no tool');
  });

  it('is still bounded when the model never calls anything at all', async () => {
    // Recovery must not become an unbounded conversation with a model that has
    // nothing to say: the stall guard still ends it.
    const flow = capability();
    const { decide } = script(turn(), turn(), turn(), turn(), turn(), turn());

    const discovered = await discover(flow, {
      ...QUIET,
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 20,
    });

    expect(discovered.ending).toBe('stalled');
    expect(discovered.turns).toBeLessThan(20);
  });
});

// @covers agent.refusal-is-named
describe('a provider refusal', () => {
  /** What a refusal looks like at the seam: no content at all, and a reason. */
  function refused(category = 'cyber'): Turn {
    return { text: '', usage: USAGE, calls: [], refusal: { category } };
  }

  it('is recorded as a refusal rather than as an ordinary empty turn', async () => {
    const flow = capability();
    const entries: Entry[] = [];
    const { decide } = script(refused(), turn({ name: 'snapshot', input: {} }));

    await discover(flow, {
      ...QUIET,
      record: (entry) => entries.push(entry),
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 3,
    });

    // Without this the turn is invisible or, worse, indistinguishable from the
    // model simply choosing to call nothing.
    const named = entries.filter(
      (entry) => entry.kind === 'model.turn' && entry.reason.startsWith('refused'),
    );
    expect(named).toHaveLength(1);
    expect(named[0]?.kind === 'model.turn' ? named[0].reason : '').toContain('cyber');
  });

  it('is answered and carried past, because it is one request and not the session', async () => {
    const flow = capability();
    const { decide } = script(
      refused(),
      ...signIn(),
      ...lookUp(),
      turn({ name: 'extract', input: { name: 'balance', target: BALANCE, parse: 'money' } }),
      turn({ name: 'returns', input: { status: 'ok', values: { balance: 'balance' } } }),
    );

    const discovered = await discover(flow, {
      ...QUIET,
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 12,
    });

    expect(discovered.ending).toBe('returned');
  });

  it('ends the run as refused, not as a stall, when it does not let up', async () => {
    // A stall is the model going in circles on a page; a refusal is the request
    // never being answered. Reporting the second as the first sends whoever
    // reads the record looking at the wrong thing.
    const flow = capability();
    const { decide } = script(refused(), refused(), refused(), refused(), refused());

    const discovered = await discover(flow, {
      ...QUIET,
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 20,
    });

    expect(discovered.ending).toBe('refused');
  });
});

describe('the terminal entry a run writes', () => {
  it('is written once, even when a step hard-failed and the run carried on', async () => {
    // A hard failure inside discovery is information, not the end: the step is
    // retracted and the model tries something else. But the failure site wrote
    // `run.finished` itself, so the record ended up claiming the run finished
    // twice, with contradictory verdicts — a live run recorded
    // `failure/hard-failure` and then `success` one second apart.
    const flow = capability();
    const entries: Entry[] = [];
    const { decide } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      // Nothing on the page answers to this, so the step fails and is retracted.
      turn({
        name: 'pressButton',
        input: { target: [{ by: 'role', role: 'button', name: 'No Such Control' }] },
      }),
      turn({ name: 'snapshot', input: {} }),
    );

    await discover(flow, {
      ...QUIET,
      record: (entry) => entries.push(entry),
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 4,
    });

    expect(entries.filter((entry) => entry.kind === 'run.finished')).toHaveLength(1);
    // And the failure itself is still on the record, as an error.
    expect(entries.some((entry) => entry.kind === 'error')).toBe(true);
  });
});

// @covers agent.open-addresses-declared-input
describe('an address the contract never declared', () => {
  it('is refused, and the model is told to act on the page or ask for an input', async () => {
    // A live run against a real site recorded `open(literal("…/login"))` and
    // then `open(join(literal("…/company/"), field("companyName"), "/about/"))`,
    // abandoning the search results it had just opened. It worked for the one
    // company whose slug matched its name, and it made the declared outcome —
    // "the first result is not a company" — undetectable by construction,
    // because no first result was ever inspected.
    const flow = capability();
    const { decide, seen } = script(
      // Both addresses are inside the allowlist and would load: what is under
      // test is the refusal, not the navigation guard.
      turn({
        name: 'open',
        input: { url: { from: 'literal', value: `${bundle.fixtures.clean.url}/login` } },
      }),
      turn({
        name: 'open',
        input: {
          url: {
            from: 'join',
            parts: [
              { from: 'literal', value: `${bundle.fixtures.clean.url}/accounts/` },
              { from: 'input', name: 'accountRef' },
            ],
          },
        },
      }),
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
    );

    const discovered = await discover(flow, {
      ...QUIET,
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 4,
    });

    // Neither constructed address is in the artifact; the declared one is.
    expect(discovered.flow.steps.map((step) => step.kind)).toEqual(['open']);

    // And the refusal said what to do instead, rather than only saying no.
    const results = seen
      .at(-1)
      ?.transcript.flatMap((one) => (one.kind === 'results' ? one.results : []));
    const refusals = (results ?? []).filter((one) => !one.ok);
    expect(refusals).toHaveLength(2);
    expect(refusals[0]?.detail).toMatch(/act on the page|ask for it as an input/i);
  });
});

// @covers target.chain-order-enforced
describe('a chain recorded out of order', () => {
  it('is refused, because a fallback winning only means drift if the stronger one went first', async () => {
    // `isBestFirst` existed, was exported and unit-tested, and was called from
    // nowhere — so a live run recorded `[css("div[data-testid=…]"), byRole(…)]`
    // and nothing objected. Now that an ambiguous primary falls through to a
    // weaker strategy, an unordered chain would report drift that did not
    // happen and hide drift that did.
    const flow = capability();
    const { decide, seen } = script(
      turn({ name: 'open', input: { url: { from: 'input', name: 'url' } } }),
      turn({
        name: 'checkpoint',
        input: {
          target: [
            { by: 'css', selector: '#username' },
            { by: 'label', text: 'Username' },
          ],
        },
      }),
      turn({
        name: 'checkpoint',
        input: {
          target: [
            { by: 'label', text: 'Username' },
            { by: 'css', selector: '#username' },
          ],
        },
      }),
    );

    const discovered = await discover(flow, {
      ...QUIET,
      task: 'read the balance of an account',
      input: liveValues(),
      decide,
      browser,
      maxTurns: 4,
    });

    // The ordered one is kept; the inverted one never entered the artifact.
    expect(discovered.flow.steps.map((step) => step.kind)).toEqual(['open', 'checkpoint']);

    const results = seen
      .at(-1)
      ?.transcript.flatMap((one) => (one.kind === 'results' ? one.results : []));
    const refused = (results ?? []).filter((one) => !one.ok);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.detail).toMatch(/best-first|order/i);
  });
});
