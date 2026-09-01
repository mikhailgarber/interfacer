import {
  byLabel,
  byRole,
  byText,
  css,
  fields,
  Flow,
  secret,
  text,
  type ActionStep,
  type Step,
} from '@interfacer/dsl';
import { describe, expect, it } from 'vitest';

/**
 * The flow as a value: what it accumulates, what it refuses to do while it is
 * being built, and what it can be asked without a page.
 *
 * These are the claims the design makes about the *shape* of the artifact rather
 * than about how it runs, so they belong here and not behind a browser. Each one
 * is a property somebody could quietly break while making the builder more
 * convenient — an accessor evaluated early "to validate it", a twelfth verb, a
 * predicate accepted where a target belongs — and none of them would show up as
 * a failing integration test.
 */

const input = fields({
  url: text(),
  username: text(),
  password: secret(),
  accountRef: text(),
});

/** Throws if anything calls it. Nothing should, while a flow is being built. */
function explode(): never {
  throw new Error('an accessor ran while the flow was being built');
}

/** Every verb in the design's vocabulary table, used once. */
function everyVerb() {
  return new Flow({ id: 'vocabulary', input })
    .open((i) => i.url)
    .fillForm([byLabel('Username'), css('#u')], (i) => i.username)
    .pressButton([byRole('button', 'Sign in')])
    .choose([css('#kind')], () => 'savings')
    .checkpoint([byRole('heading', 'Confirm transfer')])
    .pauseUntil([byRole('heading', 'Confirm transfer')], { within: '1s' })
    .pauseForInput('mfaCode', { prompt: 'Enter the code' })
    .pauseForApproval('Send it?')
    .pauseForOperator('Clear the dialog')
    .optional([byRole('dialog')], (branch) => {
      branch.pressButton([byRole('button', 'Dismiss')]);
    })
    .oneOf([
      {
        when: [byRole('heading', 'Sign in')],
        then: (branch) => {
          branch.fillForm([css('#p')], (i) => i.password);
        },
      },
      { when: [byRole('heading', 'Summary')], then: () => undefined },
    ])
    .commit([byRole('button', 'Confirm')])
    .extract('balance', [css('#balance-value')], Number)
    .outcome([byText('No such account')], (i) => ({
      status: 'account_not_found' as const,
      accountRef: i.accountRef,
    }))
    .returns(({ balance }) => ({ status: 'ok' as const, balance }));
}

/**
 * The closed vocabulary, as the design's table lists it.
 *
 * `.outcome()` and `.returns()` are absent because they declare rather than
 * step: they are asserted separately below, as the only two ways to finish.
 */
const VOCABULARY = [
  'open',
  'fillForm',
  'pressButton',
  'commit',
  'choose',
  'checkpoint',
  'extract',
  'pauseUntil',
  'pause',
  'optional',
  'oneOf',
] as const;

// @covers artifact.steps-accumulate-not-execute
describe('building a flow executes nothing', () => {
  it('never calls an accessor, a parser or an outcome mapper', () => {
    // If the builder evaluated an accessor eagerly — to type-check it, to derive
    // a step id, to be helpful — every one of these would throw during
    // construction. This is what "the step sequence is not executed eagerly"
    // means concretely.
    expect(() =>
      new Flow({ id: 'inert', input })
        .open(explode)
        .fillForm([css('#u')], explode)
        .choose([css('#k')], explode)
        .extract('value', [css('#v')], explode)
        .outcome([byText('nope')], explode)
        .returns(explode),
    ).not.toThrow();
  });

  it('accumulates the calls in order, into a value carrying the capability id', () => {
    const flow = everyVerb();

    expect(flow.id).toBe('vocabulary');
    expect(flow.steps.map((step) => step.kind)).toEqual([
      'open',
      'fillForm',
      'pressButton',
      'choose',
      'checkpoint',
      'pauseUntil',
      'pause',
      'pause',
      'pause',
      'optional',
      'oneOf',
      'commit',
      'extract',
    ]);
  });

  it('assigns every step an id while it is being built, not while it runs', () => {
    // Ids exist before anything executes, which is what lets an error name
    // `login.submit` rather than a position.
    const ids = everyVerb().steps.map((step) => step.id);

    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// @covers artifact.closed-vocabulary
describe('the vocabulary is closed', () => {
  it('produces exactly the step kinds the design names, and no other', () => {
    // Exercising every verb reaches every kind: nothing in the union is
    // unreachable, and nothing reachable is missing from the design's table.
    const produced = new Set(everyVerb().steps.map((step) => step.kind));

    expect([...produced].sort()).toEqual([...VOCABULARY].sort());
  });

  it('offers no way to append a step outside that vocabulary', () => {
    // The bound is structural rather than a matter of review discipline: a
    // twelfth verb would have to be a method here, and this is what notices.
    // Methods only: `steps`, `outcomes` and `result` are getters that read the
    // accumulated value back. Two methods append nothing and so are not verbs —
    // `stepId`, shared with `Branch`, and `retract`, which takes back a step
    // discovery proposed and the application refused.
    const NOT_A_VERB = new Set(['constructor', 'stepId', 'retract']);

    const appending = Object.getOwnPropertyNames(Flow.prototype).filter((name) => {
      const member = Object.getOwnPropertyDescriptor(Flow.prototype, name);
      return typeof member?.value === 'function' && !NOT_A_VERB.has(name);
    });

    expect(appending.sort()).toEqual(
      [...VOCABULARY, 'pauseForInput', 'pauseForApproval', 'pauseForOperator', 'outcome', 'returns']
        .filter((name) => name !== 'pause')
        .sort(),
    );
  });

  it('finishes only through `.outcome()` and `.returns()`', () => {
    const flow = everyVerb();

    expect(flow.outcomes.map((outcome) => outcome.id)).toEqual(['outcome:text="No such account"']);
    expect(typeof flow.result).toBe('function');
  });

  it('refuses a second result declaration', () => {
    expect(() =>
      new Flow({ id: 'twice', input })
        .returns(() => ({ status: 'ok' as const }))
        .returns(() => ({ status: 'ok' as const })),
    ).toThrow(/already declares a result/);
  });
});

// @covers dsl.no-general-branching
describe('the step list is statically enumerable', () => {
  /** Walk every step the flow can run, arms included, without a page. */
  function enumerate(steps: readonly Step[]): (Step | ActionStep)[] {
    return steps.flatMap((step): (Step | ActionStep)[] => {
      if (step.kind === 'optional') {
        return [step, ...step.steps];
      }
      if (step.kind === 'oneOf') {
        return [step, ...step.arms.flatMap((arm) => arm.steps)];
      }
      return [step];
    });
  }

  it('reaches every step inside a branch without executing anything', () => {
    // The whole point: the replay allowlist is computed from the flow, and a
    // step id means the same thing on every run — neither is possible if what
    // the flow contains depends on what a page did.
    const ids = enumerate(everyVerb().steps).map((step) => step.id);

    expect(ids).toContain('pressButton:role=button name="Dismiss"');
    expect(ids).toContain('fillForm:css="#p"');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives the same step list every time it is built', () => {
    const first = enumerate(everyVerb().steps).map((step) => `${step.kind}:${step.id}`);
    const second = enumerate(everyVerb().steps).map((step) => `${step.kind}:${step.id}`);

    expect(first).toEqual(second);
  });

  it('makes every branch point a target, never a predicate over page state', () => {
    // This is the assertion with teeth. `.optional(page => page.hasDialog())`
    // would be general branching, and would make the step list a function of the
    // run rather than a property of the artifact. A `TargetChain` is data: it can
    // be read, computed over, and printed without a browser.
    const flow = everyVerb();

    const branchPoints = flow.steps.flatMap((step) => {
      if (step.kind === 'optional') {
        return [step.target];
      }
      if (step.kind === 'oneOf') {
        return step.arms.map((arm) => arm.when);
      }
      return [];
    });

    expect(branchPoints).toHaveLength(3);
    for (const chain of branchPoints) {
      expect(Array.isArray(chain)).toBe(true);
      expect(chain.every((target) => typeof target === 'object' && 'by' in target)).toBe(true);
      expect(JSON.parse(JSON.stringify(chain))).toEqual(chain);
    }
  });

  it('records an outcome detector the same way, so an ending is enumerable too', () => {
    const [detector] = everyVerb().outcomes.map((outcome) => outcome.detector);

    expect(detector?.every((target) => typeof target === 'object' && 'by' in target)).toBe(true);
  });
});
