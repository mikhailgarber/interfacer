/**
 * The contract an interview establishes, and the rules for when it is settled.
 *
 * This is the mechanical half of interview mode. A model conducts the
 * conversation and turns prose into answers; what an answer has to be, which
 * ones are still missing, and — for the two guardrails Interfacer *proposes*
 * rather than asks — who is allowed to have settled them, are decided here,
 * where a test can reach them without a model.
 *
 * The draft is deliberately three-valued. An answer is present, or absent, and
 * an empty list is present: "this task has no business outcomes" is an answer a
 * user gave, and "nobody asked yet" is not. Collapsing them would let a run
 * proceed on a question that was never put.
 */
import type { Effects, FieldKind, HostPattern, PauseKind } from '@interfacer/dsl';

/** One input the task takes, in the words the interview captured. */
export interface InputAnswer {
  readonly name: string;
  readonly kind: FieldKind;
  /**
   * Not decoration: it becomes the field description in the generated MCP
   * schema, which is what a calling agent reads to decide what to pass.
   */
  readonly description?: string;
}

/** A way the task can legitimately end besides success. */
export interface OutcomeAnswer {
  readonly id: string;
  readonly description?: string;
}

/** A place the task must stop and ask a human for something. */
export interface InteractionAnswer {
  readonly kind: PauseKind;
  readonly name: string;
  readonly prompt: string;
  readonly secret: boolean;
}

/** The effects declaration under construction. */
export type EffectsDraft = { readonly [K in keyof Effects]?: Effects[K] };

/**
 * Who settled a guarded answer.
 *
 * A model that resolves its own constraints has not been constrained, so the
 * allowlist and `securityEffect` carry the authority that put them there.
 * `model` is not one of the values on purpose: there is no way to record one
 * from the model's own proposal.
 */
export type Authority =
  /** Read back from a project a human already accepted and committed. */
  | 'project'
  /** Stated in the interview file, which is the authorization record. */
  | 'file'
  /** Confirmed in the conversation, by the person having it. */
  | 'human';

/** The two answers Interfacer proposes rather than asks. */
export const GUARDED = ['allowlist', 'securityEffect'] as const;

export type Guarded = (typeof GUARDED)[number];

export interface ContractDraft {
  /** Names the exported master function, so it has to be a plain identifier. */
  readonly capability?: string;
  readonly task?: string;
  readonly entryPoint?: string;
  readonly inputs?: readonly InputAnswer[];
  readonly output?: string;
  readonly outcomes?: readonly OutcomeAnswer[];
  readonly interactions?: readonly InteractionAnswer[];
  readonly effects?: EffectsDraft;
  readonly allowlist?: readonly HostPattern[];
  /** A cost ceiling. Required only where nobody is watching the run. */
  readonly budgetUsd?: number;
  /** What authorized each guarded answer. Only `applyAnswers` writes it. */
  readonly authority?: Readonly<Partial<Record<Guarded, Authority>>>;
}

/**
 * What the model established on one turn.
 *
 * A patch rather than a whole draft: the interview establishes answers as the
 * conversation reaches them, and a model handing back everything it knows each
 * turn would silently overwrite a confirmation with its own recollection.
 */
export interface AnswerPatch {
  readonly capability?: string;
  readonly task?: string;
  readonly entryPoint?: string;
  readonly inputs?: readonly InputAnswer[];
  readonly output?: string;
  readonly outcomes?: readonly OutcomeAnswer[];
  readonly interactions?: readonly InteractionAnswer[];
  readonly effects?: EffectsDraft;
  readonly allowlist?: readonly HostPattern[];
  readonly budgetUsd?: number;
  /**
   * The sentence in the interview file that authorizes the guarded answers in
   * this patch. Checked against the file; without it they are dropped.
   */
  readonly citation?: string;
}

/** A settled contract: every question answered, every guardrail authorized. */
export interface Contract {
  readonly capability: string;
  readonly task: string;
  readonly entryPoint: string;
  readonly inputs: readonly InputAnswer[];
  readonly output: string;
  readonly outcomes: readonly OutcomeAnswer[];
  readonly interactions: readonly InteractionAnswer[];
  readonly effects: Effects;
  readonly allowlist: readonly HostPattern[];
  readonly budgetUsd?: number;
  readonly authority: Readonly<Record<Guarded, Authority>>;
}

/** One answer still needed, named so a person can go and write it down. */
export interface Gap {
  readonly id: string;
  readonly question: string;
}

const EFFECT_QUESTIONS: Readonly<Record<string, string>> = {
  mutates: 'does this only read, or does it change something?',
  idempotent: 'if this ran twice by mistake, would that be a problem?',
  reversible: 'if it changes something, can that be undone?',
  securityEffect: 'does it change who can access the account afterwards?',
  scope: 'how many records does one run touch?',
  external: 'does it reach beyond the application — a customer, a third party?',
  financial: 'does it move money?',
  dataClasses: 'what kinds of data does it observe?',
};

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/**
 * What is still missing, in the order a person would answer it.
 *
 * The list is the whole point of the non-interactive path: an unattended run
 * with insufficient answers exits saying which ones, so filling them in and
 * re-running is the loop.
 */
export function gaps(
  draft: ContractDraft,
  options: { readonly interactive: boolean } = { interactive: true },
): readonly Gap[] {
  const missing: Gap[] = [];
  const need = (id: string, question: string): void => void missing.push({ id, question });

  if (blank(draft.capability)) {
    need('capability', 'what should the capability be called?');
  }
  if (blank(draft.task)) {
    need('task', 'what is the task, in a sentence or two?');
  }
  if (blank(draft.entryPoint)) {
    need('entryPoint', 'what URL does the task start from?');
  }
  if (draft.inputs === undefined) {
    need('inputs', 'what inputs does the task take, and which of them are secrets?');
  }
  if (blank(draft.output)) {
    need('output', 'what shape does a successful run return?');
  }
  if (draft.outcomes === undefined) {
    need('outcomes', 'what else can happen instead of success?');
  }
  if (draft.interactions === undefined) {
    need('interactions', 'will this ever stop and ask you for something?');
  }

  const effects = draft.effects ?? {};
  for (const dimension of ['mutates', 'reversible', 'scope', 'external', 'financial'] as const) {
    if (effects[dimension] === undefined) {
      need(`effects.${dimension}`, EFFECT_QUESTIONS[dimension] ?? dimension);
    }
  }
  if (effects.dataClasses === undefined) {
    need('effects.dataClasses', EFFECT_QUESTIONS.dataClasses ?? 'dataClasses');
  }
  // Asked only where it can matter. The design puts the second effects question
  // behind the first — "does it change something?" and, *if it does*, "would
  // running it twice be a problem?" — and a read is idempotent by construction
  // rather than by anybody's choice.
  if (effects.mutates === 'write' && effects.idempotent === undefined) {
    need('effects.idempotent', EFFECT_QUESTIONS.idempotent ?? 'idempotent');
  }

  // The two guardrails. Present is not enough: a value nobody authorized is the
  // model having settled its own constraint, which is the thing being prevented.
  if (effects.securityEffect === undefined) {
    need('effects.securityEffect', EFFECT_QUESTIONS.securityEffect ?? 'securityEffect');
  } else if (draft.authority?.securityEffect === undefined) {
    need(
      'effects.securityEffect',
      'the proposed securityEffect is not confirmed anywhere a human wrote',
    );
  }

  if (draft.allowlist === undefined || draft.allowlist.length === 0) {
    need('allowlist', 'which hosts may the automation visit?');
  } else if (draft.authority?.allowlist === undefined) {
    need('allowlist', 'the proposed allowlist is not confirmed anywhere a human wrote');
  }

  // A run nobody is watching needs a spending bound, and there is no fallback
  // default: a default nobody chose is not an authorization. Interactively
  // there is nothing to bound — Interfacer reports what the run cost instead.
  if (!options.interactive && draft.budgetUsd === undefined) {
    need('budget', 'what may this discovery run cost, in dollars?');
  }

  return missing;
}

export class IncompleteContract extends Error {
  readonly missing: readonly Gap[];

  constructor(missing: readonly Gap[]) {
    super(`the interview is not settled: ${missing.map((gap) => gap.id).join(', ')}`);
    this.name = new.target.name;
    this.missing = missing;
  }
}

/**
 * Freeze a settled draft into the contract generation is given.
 *
 * Everything here is an answer somebody gave. The one value filled in rather
 * than asked for is `idempotent` on a read, which the answer to `mutates`
 * already entails.
 */
export function settle(
  draft: ContractDraft,
  options: { readonly interactive: boolean } = { interactive: true },
): Contract {
  const missing = gaps(draft, options);
  if (missing.length > 0) {
    throw new IncompleteContract(missing);
  }

  const effects = draft.effects ?? {};
  return {
    capability: must(draft.capability, 'capability'),
    task: must(draft.task, 'task'),
    entryPoint: must(draft.entryPoint, 'entryPoint'),
    inputs: must(draft.inputs, 'inputs'),
    output: must(draft.output, 'output'),
    outcomes: must(draft.outcomes, 'outcomes'),
    interactions: must(draft.interactions, 'interactions'),
    effects: {
      mutates: must(effects.mutates, 'effects.mutates'),
      reversible: must(effects.reversible, 'effects.reversible'),
      securityEffect: must(effects.securityEffect, 'effects.securityEffect'),
      scope: must(effects.scope, 'effects.scope'),
      external: must(effects.external, 'effects.external'),
      financial: must(effects.financial, 'effects.financial'),
      // Entailed by the answer to `mutates` rather than defaulted: a read is
      // idempotent by construction, so the question is never put.
      idempotent: effects.idempotent ?? true,
      dataClasses: must(effects.dataClasses, 'effects.dataClasses'),
    },
    allowlist: must(draft.allowlist, 'allowlist'),
    ...(draft.budgetUsd === undefined ? {} : { budgetUsd: draft.budgetUsd }),
    authority: {
      allowlist: must(draft.authority?.allowlist, 'allowlist'),
      securityEffect: must(draft.authority?.securityEffect, 'effects.securityEffect'),
    },
  };
}

/**
 * An answer {@link gaps} already found present.
 *
 * The check runs a second time rather than being asserted away, because the two
 * are separate readings of the same draft and a contract built past a missing
 * answer is the one thing this module exists to prevent.
 */
function must<T>(value: T | undefined, id: string): T {
  if (value === undefined) {
    throw new IncompleteContract([{ id, question: `${id} is missing` }]);
  }
  return value;
}
