/**
 * The flow: a capability's recorded steps, accumulated into an in-memory object.
 *
 * DSL calls are not executed eagerly. They append to this builder, which the
 * engine then walks. Nothing is serialized out of it — there is no manifest, no
 * step file, no exported description. The source is the artifact, and a
 * normalized data form would only be a second copy of the same facts, free to
 * drift from the code it claims to describe.
 *
 * The vocabulary is closed. A capability can do nothing the DSL does not name,
 * so what one can do is bounded structurally rather than by review discipline.
 *
 * There is no general branching. A flow is a builder, so plain TypeScript
 * control flow cannot branch on page state anyway — an `if` runs while the flow
 * is being built, before anything has executed. A statically enumerable step
 * list is what lets the replay allowlist be computed from the flow and lets a
 * step id mean the same thing on every run.
 */
/* eslint-disable @typescript-eslint/prefer-return-this-type --
   `.outcome()` and `.returns()` must return a *widened* `Flow` type rather than
   `this`. `A` is a phantom parameter, so both type-check and the compiler cannot
   tell them apart — but only the widened form carries the new arm into
   `AnswerOf`. `eslint --fix` applied this rule once and silently collapsed every
   answer union to its success arm. `flow.test-d.ts` is what catches it. */
import type { HostPattern } from './allowlist.js';
import type { FieldSet, Infer } from './fields.js';
import type { Secret } from './secret.js';
import { describeTarget, type TargetChain } from './target.js';

/** Values are taken as accessors on the input, so a flow is parameterized by construction. */
export type Accessor<I, T> = (input: I) => T;

/**
 * Flatten an intersection into a plain object type.
 *
 * `.extract()` accumulates by intersecting, and an unflattened
 * `object & Record<'balance', number> & Record<'reference', string>` is the same
 * type as `{ balance: number; reference: string }` but reads as neither — not in
 * an editor tooltip, and not in the generated documentation. What `.returns()`
 * receives is part of the contract, so it is worth flattening.
 */
type Simplify<T> = { [K in keyof T]: T[K] };

export type FillValue = string | Secret;

/** Steps an `.optional()` or a `.oneOf()` arm may contain. */
export type ActionStep =
  | {
      readonly kind: 'fillForm';
      readonly id: string;
      readonly target: TargetChain;
      readonly value: Accessor<never, FillValue>;
    }
  | { readonly kind: 'pressButton'; readonly id: string; readonly target: TargetChain }
  | {
      readonly kind: 'choose';
      readonly id: string;
      readonly target: TargetChain;
      readonly value: Accessor<never, string>;
    };

export type Step =
  | { readonly kind: 'open'; readonly id: string; readonly url: Accessor<never, string> }
  | ActionStep
  /** A `.pressButton()` understood to be irreversible. Never retried. */
  | { readonly kind: 'commit'; readonly id: string; readonly target: TargetChain }
  | { readonly kind: 'checkpoint'; readonly id: string; readonly target: TargetChain }
  | {
      readonly kind: 'extract';
      readonly id: string;
      readonly name: string;
      readonly target: TargetChain;
      readonly parse: (text: string) => unknown;
    }
  /** A no-op when the target does not resolve — an intermittent consent screen. */
  | {
      readonly kind: 'optional';
      readonly id: string;
      readonly target: TargetChain;
      readonly steps: readonly ActionStep[];
    }
  /** One of a small set of expected screens, each arm naming its detector. */
  | {
      readonly kind: 'oneOf';
      readonly id: string;
      readonly arms: readonly {
        readonly when: TargetChain;
        readonly steps: readonly ActionStep[];
      }[];
    };

/** A declared business outcome: a legitimate answer, returned rather than thrown. */
export interface OutcomeDeclaration {
  readonly id: string;
  readonly detector: TargetChain;
  readonly map: Accessor<never, unknown>;
}

export interface StepOptions {
  /**
   * A stable identifier, so errors and evidence refer to `login.submit` rather
   * than to a position that shifts whenever the flow is edited.
   *
   * When omitted it is derived from the verb and the primary target, which is
   * stable under reordering — unlike an index. Interfacer's generator always
   * emits an explicit one; the derived form is a convenience for flows written
   * by hand.
   */
  readonly id?: string;
}

export interface FlowOptions<I extends FieldSet> {
  readonly id: string;
  readonly input: I;
  /**
   * Hosts the recorded flow legitimately reached beyond its entry point — an SSO
   * redirect, an asset host.
   *
   * The entry point itself is never listed. It is an ordinary input, so one
   * artifact serves every tenant that differs only by host; the engine admits
   * the origin the caller actually opened. What this list guards is everywhere
   * *else* the flow might be taken, which is the part a caller did not choose.
   */
  readonly allowlist?: readonly HostPattern[];
}

/** A sub-builder for the steps inside an `.optional()` or a `.oneOf()` arm. */
export class Branch<I extends FieldSet> {
  readonly #steps: ActionStep[] = [];
  readonly #owner: Flow<I>;

  constructor(owner: Flow<I>) {
    this.#owner = owner;
  }

  get steps(): readonly ActionStep[] {
    return this.#steps;
  }

  fillForm(
    target: TargetChain,
    value: Accessor<Infer<I>, FillValue>,
    options: StepOptions = {},
  ): this {
    this.#steps.push({
      kind: 'fillForm',
      id: this.#owner.stepId('fillForm', target, options),
      target,
      value: value,
    });
    return this;
  }

  pressButton(target: TargetChain, options: StepOptions = {}): this {
    this.#steps.push({
      kind: 'pressButton',
      id: this.#owner.stepId('pressButton', target, options),
      target,
    });
    return this;
  }

  choose(target: TargetChain, value: Accessor<Infer<I>, string>, options: StepOptions = {}): this {
    this.#steps.push({
      kind: 'choose',
      id: this.#owner.stepId('choose', target, options),
      target,
      value: value,
    });
    return this;
  }
}

/**
 * A capability's steps, its declared outcomes, and its success result.
 *
 * `A` accumulates the answer union as `.outcome()` and `.returns()` are chained,
 * and `E` accumulates what `.extract()` has read. Both are consequences of the
 * steps rather than separate declarations: a hand-written arm with no detector
 * would be unreachable and a detector with no arm would not type-check, and
 * nothing would catch either.
 *
 * A flow is built once and then walked. The builder mutates, so the value
 * returned by each call is the same object with a wider type.
 *
 * **`A` is a phantom parameter.** It appears in no member, so `Flow<I, X, E>`
 * and `Flow<I, Y, E>` are structurally identical and mutually assignable — which
 * means the compiler will not stop `.outcome()` and `.returns()` from being
 * "simplified" to return `this`, and `eslint --fix` has done exactly that once.
 * Doing so silently stops the answer union widening and makes `AnswerOf` report
 * only what the last call added. The declared return types below are load-bearing
 * even though nothing in the implementation needs them; `flow.test-d.ts` is what
 * fails if they are lost.
 */
export class Flow<I extends FieldSet, A = never, E extends object = object> {
  readonly id: string;
  readonly input: I;
  readonly declaredAllowlist: readonly HostPattern[];

  readonly #steps: Step[] = [];
  readonly #outcomes: OutcomeDeclaration[] = [];
  readonly #usedIds = new Set<string>();
  #result: Accessor<never, unknown> | undefined;

  constructor(options: FlowOptions<I>) {
    this.id = options.id;
    this.input = options.input;
    this.declaredAllowlist = options.allowlist ?? [];
  }

  get steps(): readonly Step[] {
    return this.#steps;
  }

  get outcomes(): readonly OutcomeDeclaration[] {
    return this.#outcomes;
  }

  /** The `.returns()` mapper, absent until the flow declares one. */
  get result(): Accessor<never, unknown> | undefined {
    return this.#result;
  }

  /** @internal — shared with {@link Branch}. */
  stepId(verb: string, target: TargetChain | undefined, options: StepOptions): string {
    if (options.id !== undefined) {
      if (this.#usedIds.has(options.id)) {
        throw new Error(`duplicate step id ${JSON.stringify(options.id)} in flow ${this.id}`);
      }
      this.#usedIds.add(options.id);
      return options.id;
    }

    // Derived from what the step *does*, not from where it sits, so inserting a
    // step above it does not rename it.
    const base = target === undefined ? verb : `${verb}:${describeTarget(target[0])}`;

    let candidate = base;
    for (let n = 2; this.#usedIds.has(candidate); n++) {
      candidate = `${base}#${String(n)}`;
    }
    this.#usedIds.add(candidate);
    return candidate;
  }

  #push(step: Step): this {
    this.#steps.push(step);
    return this;
  }

  /** Go to an entry point. Allowlist-checked on the resolved URL. */
  open(url: Accessor<Infer<I>, string>, options: StepOptions = {}): this {
    return this.#push({
      kind: 'open',
      id: this.stepId('open', undefined, options),
      url: url,
    });
  }

  fillForm(
    target: TargetChain,
    value: Accessor<Infer<I>, FillValue>,
    options: StepOptions = {},
  ): this {
    return this.#push({
      kind: 'fillForm',
      id: this.stepId('fillForm', target, options),
      target,
      value: value,
    });
  }

  pressButton(target: TargetChain, options: StepOptions = {}): this {
    return this.#push({
      kind: 'pressButton',
      id: this.stepId('pressButton', target, options),
      target,
    });
  }

  /**
   * Activate the control that is the point of no return.
   *
   * A `.pressButton()` understood to be irreversible. It exists because several
   * rules need to name that step: it is never retried, since a timed-out commit
   * may already have gone through; approval required by the declared effects
   * must precede it; the run record marks it as where the dangerous thing
   * happened; and a reader scanning a flow can see where it stops being
   * reversible.
   */
  commit(target: TargetChain, options: StepOptions = {}): this {
    return this.#push({ kind: 'commit', id: this.stepId('commit', target, options), target });
  }

  choose(target: TargetChain, value: Accessor<Infer<I>, string>, options: StepOptions = {}): this {
    return this.#push({
      kind: 'choose',
      id: this.stepId('choose', target, options),
      target,
      value: value,
    });
  }

  /** Assert the expected state was reached. */
  checkpoint(target: TargetChain, options: StepOptions = {}): this {
    return this.#push({
      kind: 'checkpoint',
      id: this.stepId('checkpoint', target, options),
      target,
    });
  }

  /** Read a value out of the page. Widens what `.returns()` receives. */
  extract<N extends string, T>(
    name: N,
    target: TargetChain,
    parse: (text: string) => T,
    options: StepOptions = {},
  ): Flow<I, A, Simplify<E & Record<N, T>>> {
    this.#push({
      kind: 'extract',
      id: this.stepId('extract', target, options),
      name,
      target,
      parse: parse,
    });
    return this as unknown as Flow<I, A, Simplify<E & Record<N, T>>>;
  }

  /** Run a step only if the target resolves. A no-op when it does not. */
  optional(
    target: TargetChain,
    build: (branch: Branch<I>) => void,
    options: StepOptions = {},
  ): this {
    const branch = new Branch<I>(this);
    build(branch);
    return this.#push({
      kind: 'optional',
      id: this.stepId('optional', target, options),
      target,
      steps: branch.steps,
    });
  }

  /**
   * Take one of a small set of expected screens.
   *
   * The arms stay enumerable, which is what keeps the flow statically
   * inspectable. An arm performs actions only: it cannot declare an outcome or
   * a result, so the answer union stays a property of the flow rather than of
   * whichever arm happened to run.
   */
  oneOf(
    arms: readonly { when: TargetChain; then: (branch: Branch<I>) => void }[],
    options: StepOptions = {},
  ): this {
    return this.#push({
      kind: 'oneOf',
      id: this.stepId('oneOf', arms[0]?.when, options),
      arms: arms.map((arm) => {
        const branch = new Branch<I>(this);
        arm.then(branch);
        return { when: arm.when, steps: branch.steps };
      }),
    });
  }

  /**
   * Declare a business outcome and how it is detected.
   *
   * Evaluated in declaration order whenever a step's verification fails, before
   * a hard failure is raised. That ordering is the whole reason "no such
   * account" is not a crash.
   */
  outcome<O>(
    detector: TargetChain,
    map: Accessor<Infer<I>, O>,
    options: StepOptions = {},
  ): Flow<I, A | O, E> {
    this.#outcomes.push({
      id: this.stepId('outcome', detector, options),
      detector,
      map: map,
    });
    return this;
  }

  returns<R>(map: (extracted: E) => R): Flow<I, A | R, E> {
    if (this.#result !== undefined) {
      throw new Error(`flow ${this.id} already declares a result`);
    }
    this.#result = map;
    return this;
  }
}

/** The result union a flow can produce, inferred from its `.outcome()` and `.returns()` calls. */
export type AnswerOf<F> = F extends Flow<FieldSet, infer A> ? A : never;

/** The input object a flow requires. */
export type InputOf<F> = F extends Flow<infer I, unknown> ? Infer<I> : never;
