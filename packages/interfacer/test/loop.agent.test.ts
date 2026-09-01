import { startAll, type FixtureBundle } from '@interfacer/fixtures';
import {
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
import { discover, TOOLS, type Decide, type DiscoveryState, type Turn } from 'interfacer';
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

// @covers agent.sees-the-accessibility-tree agent.screenshot-is-never-a-target
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
    // Genuinely novel every turn: each call navigates somewhere slightly
    // different, so the page keeps changing and a step keeps being appended —
    // the stall guard never fires. Reporting no usage means the budget never
    // fires either. Something still has to end the run.
    let n = 0;
    const decide: Decide = () => {
      n += 1;
      return Promise.resolve({
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        calls: [
          {
            id: `loop_${String(n)}`,
            name: 'open',
            input: {
              url: {
                from: 'join',
                parts: [
                  { from: 'input', name: 'url' },
                  { from: 'literal', value: `/?n=${String(n)}` },
                ],
              },
            },
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
