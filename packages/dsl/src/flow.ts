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
import { checkAnswerSources } from './accessors.js';
import { DEFAULT_EFFECTS, type Effects } from './effects.js';
import type { FieldSet, Infer } from './fields.js';
import {
  DEFAULT_INTERACTION_BOUND_MS,
  DEFAULT_SURFACE_BOUND_MS,
  parseDuration,
  type Duration,
  type InteractionDeclaration,
  type PauseKind,
} from './pause.js';
import type { Secret } from './secret.js';
import { describeTarget, type TargetChain } from './target.js';

/**
 * Values are taken as accessors, so a flow is parameterized by construction and
 * embeds no live value.
 *
 * The second argument is what `.pauseForInput()` has obtained so far. It is a
 * second argument rather than a merge into the input because the two have
 * different provenance and different rules: `I` is the declared contract, known
 * before the run starts and projected into the CLI parser and the MCP schema,
 * while `P` is asked for mid-run and has never been through a field
 * declaration. Folding them together would let an MFA code look like a declared
 * parameter, and a declared parameter look like something a human will be asked
 * for.
 *
 * Every accessor written against the input alone — `i => i.username` — remains
 * valid unchanged, because a function may ignore arguments it is passed.
 */
export type Accessor<I, P, T> = (input: I, obtained: P) => T;

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
      readonly value: Accessor<never, never, FillValue>;
    }
  | { readonly kind: 'pressButton'; readonly id: string; readonly target: TargetChain }
  | {
      readonly kind: 'choose';
      readonly id: string;
      readonly target: TargetChain;
      readonly value: Accessor<never, never, string>;
    };

/**
 * A bounded suspension.
 *
 * Waiting and human escalation are the same primitive — suspend, let something
 * outside the flow change the world, resume after re-checking a precondition —
 * and they differ only in the resolver. `pauseUntil` is resolved by polling and
 * so carries a target; the other three are resolved by a human and so carry a
 * prompt. They are one step kind for that reason: a caller's policy about being
 * asked lives in one place rather than three.
 */
export type PauseStep =
  | {
      readonly kind: 'pauseUntil';
      readonly id: string;
      readonly target: TargetChain;
      readonly withinMs: number;
    }
  | {
      readonly kind: 'pause';
      readonly id: string;
      readonly pauseKind: PauseKind;
      readonly name: string;
      readonly prompt: string;
      readonly withinMs: number;
    };

export type Step =
  | { readonly kind: 'open'; readonly id: string; readonly url: Accessor<never, never, string> }
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
    }
  | PauseStep;

/** A declared business outcome: a legitimate answer, returned rather than thrown. */
export interface OutcomeDeclaration {
  readonly id: string;
  readonly detector: TargetChain;
  readonly map: Accessor<never, never, unknown>;
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

/**
 * Every pause is bounded, so an escalation nobody answers becomes a hard failure
 * with evidence rather than a hang. `within` is that bound; omitting it takes a
 * default rather than leaving the pause unbounded.
 */
export interface PauseOptions extends StepOptions {
  readonly within?: Duration;
}

export type PauseUntilOptions = PauseOptions;

export interface PauseForInputOptions extends PauseOptions {
  /** What the human is asked. Authored, so it carries no page data. */
  readonly prompt: string;
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
  /**
   * What this capability does, published in the contract.
   *
   * Optional here and required of a generated project: the interview asks and
   * generation always emits one, so only a flow written by hand omits it. When
   * it does, {@link DEFAULT_EFFECTS} applies and `run.started` records that it
   * was defaulted rather than declared.
   */
  readonly effects?: Effects;
}

/**
 * A sub-builder for the steps inside an `.optional()` or a `.oneOf()` arm.
 *
 * `P` is what `.pauseForInput()` had obtained at the point the branch was
 * written, so an arm can spend a value asked for earlier but cannot see one
 * asked for after it.
 */
export class Branch<I extends FieldSet, P extends object = object> {
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
    value: Accessor<Infer<I>, P, FillValue>,
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

  choose(
    target: TargetChain,
    value: Accessor<Infer<I>, P, string>,
    options: StepOptions = {},
  ): this {
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
export class Flow<
  I extends FieldSet,
  A = never,
  E extends object = object,
  P extends object = object,
> {
  readonly id: string;
  readonly input: I;
  readonly declaredAllowlist: readonly HostPattern[];
  readonly effects: Effects;
  /** Whether {@link effects} was declared or fell back to the default. */
  readonly effectsDeclared: boolean;

  readonly #steps: Step[] = [];
  readonly #outcomes: OutcomeDeclaration[] = [];
  readonly #usedIds = new Set<string>();
  readonly #obtainedNames = new Set<string>();
  #result: Accessor<never, never, unknown> | undefined;

  constructor(options: FlowOptions<I>) {
    this.id = options.id;
    this.input = options.input;
    this.declaredAllowlist = options.allowlist ?? [];
    this.effects = options.effects ?? DEFAULT_EFFECTS;
    this.effectsDeclared = options.effects !== undefined;
  }

  get steps(): readonly Step[] {
    return this.#steps;
  }

  get outcomes(): readonly OutcomeDeclaration[] {
    return this.#outcomes;
  }

  /** The `.returns()` mapper, absent until the flow declares one. */
  get result(): Accessor<never, never, unknown> | undefined {
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
  open(url: Accessor<Infer<I>, P, string>, options: StepOptions = {}): this {
    return this.#push({
      kind: 'open',
      id: this.stepId('open', undefined, options),
      url: url,
    });
  }

  fillForm(
    target: TargetChain,
    value: Accessor<Infer<I>, P, FillValue>,
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

  choose(
    target: TargetChain,
    value: Accessor<Infer<I>, P, string>,
    options: StepOptions = {},
  ): this {
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
  ): Flow<I, A, Simplify<E & Record<N, T>>, P> {
    this.#push({
      kind: 'extract',
      id: this.stepId('extract', target, options),
      name,
      target,
      parse: parse,
    });
    return this as unknown as Flow<I, A, Simplify<E & Record<N, T>>, P>;
  }

  /**
   * Wait for a predicate, with a bound. Never a sleep.
   *
   * `.wait(2000)` cannot distinguish "loaded in 200ms" from "never loaded"; a
   * predicate can. The bound only ever says how long the predicate may stay
   * false, which is what keeps "slow" and "broken" separable.
   *
   * Resolved by polling rather than by a human, so it raises no
   * `InteractionRequest`, appears in no `interactions` declaration, and cannot
   * make a capability attended. Its expiry goes round the ordinary verification
   * ladder — retry, then the declared detectors, then a hard failure — because a
   * surface that never arrived is exactly the condition an outcome detector may
   * legitimately explain.
   */
  pauseUntil(target: TargetChain, options: PauseUntilOptions = {}): this {
    return this.#push({
      kind: 'pauseUntil',
      id: this.stepId('pauseUntil', target, options),
      target,
      withinMs: parseDuration(options.within ?? DEFAULT_SURFACE_BOUND_MS),
    });
  }

  /**
   * Ask a human for a value that cannot be known in advance — MFA, a one-time
   * token.
   *
   * The answer is bound under `name` and read by later accessors as their second
   * argument, so it is spent the same way an input is: `(i, got) => got.mfaCode`.
   * It arrives as a `Secret`, because a value obtained mid-run has never been
   * through the field declarations and nothing else would redact it.
   */
  pauseForInput<N extends string>(
    name: N,
    options: PauseForInputOptions,
  ): Flow<I, A, E, Simplify<P & Record<N, Secret>>> {
    if (this.#obtainedNames.has(name)) {
      throw new Error(`duplicate obtained value ${JSON.stringify(name)} in flow ${this.id}`);
    }
    this.#obtainedNames.add(name);

    this.#push({
      kind: 'pause',
      id: this.stepId(`pauseForInput:${name}`, undefined, options),
      pauseKind: 'input',
      name,
      prompt: options.prompt,
      withinMs: parseDuration(options.within ?? DEFAULT_INTERACTION_BOUND_MS),
    });
    return this as unknown as Flow<I, A, E, Simplify<P & Record<N, Secret>>>;
  }

  /**
   * Ask a human to authorize a risky or irreversible step.
   *
   * A refusal ends the run, and so does an unanswered bound: an approval that
   * expires is treated as a deny, because silence is not consent.
   */
  pauseForApproval(prompt: string, options: PauseOptions = {}): this {
    const id = this.stepId('pauseForApproval', undefined, options);
    return this.#push({
      kind: 'pause',
      id,
      pauseKind: 'approval',
      name: id,
      prompt,
      withinMs: parseDuration(options.within ?? DEFAULT_INTERACTION_BOUND_MS),
    });
  }

  /**
   * Hand the live session to a human — an unexpected dialog, an uncovered
   * screen.
   *
   * The flow stops driving the browser; the human uses that same window and
   * signals when they are done. Because a human has touched the session, resume
   * re-asserts the last checkpoint that passed rather than assuming where the
   * flow now is.
   */
  pauseForOperator(reason: string, options: PauseOptions = {}): this {
    const id = this.stepId('pauseForOperator', undefined, options);
    return this.#push({
      kind: 'pause',
      id,
      pauseKind: 'operator',
      name: id,
      prompt: reason,
      withinMs: parseDuration(options.within ?? DEFAULT_INTERACTION_BOUND_MS),
    });
  }

  /** Run a step only if the target resolves. A no-op when it does not. */
  optional(
    target: TargetChain,
    build: (branch: Branch<I, P>) => void,
    options: StepOptions = {},
  ): this {
    const branch = new Branch<I, P>(this);
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
    arms: readonly { when: TargetChain; then: (branch: Branch<I, P>) => void }[],
    options: StepOptions = {},
  ): this {
    return this.#push({
      kind: 'oneOf',
      id: this.stepId('oneOf', arms[0]?.when, options),
      arms: arms.map((arm) => {
        const branch = new Branch<I, P>(this);
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
    map: Accessor<Infer<I>, P, O>,
    options: StepOptions = {},
  ): Flow<I, A | O, E, P> {
    // An outcome fires on a page whose values were never extracted, so its map
    // is handed the input. A map built to read extracted values would read the
    // wrong object and quietly report `undefined` for every field.
    checkAnswerSources(map, 'input', '.outcome()');
    this.#outcomes.push({
      id: this.stepId('outcome', detector, options),
      detector,
      map: map,
    });
    return this;
  }

  returns<R>(map: (extracted: E) => R): Flow<I, A | R, E, P> {
    checkAnswerSources(map, 'extracted', '.returns()');
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

/**
 * The pauses a capability declares, keyed by name.
 *
 * Published alongside the contract, so a caller knows before invoking that this
 * capability will stop and ask. Projected from the steps rather than declared
 * separately, for the same reason the answer union is: a second declaration
 * would be free to disagree with the flow, and nothing would catch it.
 */
export function interactionsOf(
  flow: Flow<FieldSet, unknown>,
): Readonly<Record<string, InteractionDeclaration>> {
  const declarations: Record<string, InteractionDeclaration> = {};

  for (const step of flow.steps) {
    if (step.kind === 'pause') {
      declarations[step.name] = {
        kind: step.pauseKind,
        name: step.name,
        prompt: step.prompt,
        // Every value asked for mid-run is a secret: it has never been through
        // the field declarations, so nothing else would redact it.
        secret: step.pauseKind === 'input',
      };
    }
  }

  return Object.freeze(declarations);
}

/**
 * Whether a capability needs an attended session.
 *
 * Not declared separately, deliberately: it is whether `interactions` is
 * non-empty. Declaring both would let a capability announce an MFA pause and
 * claim to run unattended, and nothing would catch the contradiction.
 */
export function isAttended(flow: Flow<FieldSet, unknown>): boolean {
  return Object.keys(interactionsOf(flow)).length > 0;
}
