/**
 * How an answer gets into the draft — and, for the two guardrails, who is
 * allowed to have put it there.
 *
 * Interfacer proposes the allowlist and `securityEffect` rather than asking for
 * them, so they are the two answers a model could quietly settle for itself.
 * This is the only writer of a draft, and it refuses a guarded answer that no
 * human authorized: confirmed in the conversation, stated in the interview file,
 * or read back from a project somebody already accepted and committed.
 *
 * A citation is what stands in for the confirmation event where there is nobody
 * present to have it. The file is the authorization record, so an answer
 * claiming to come from it has to quote it, and the quote has to be there.
 */
import type { AnswerPatch, Authority, ContractDraft, EffectsDraft, Guarded } from './contract.js';

/**
 * Who is settling this patch.
 *
 * `model` is a value here and not in `Authority` for exactly one reason: the
 * model's own words reach this function, and stop at it.
 */
export type Authorization =
  /** The model, reading the interview file. A guarded answer must quote it. */
  | { readonly by: 'file'; readonly text: string }
  /** A person, confirming a proposal put to them just now. */
  | { readonly by: 'human' }
  /** The declarations of a project a person accepted and committed. */
  | { readonly by: 'project' }
  /** The model, in its own voice. Guarded answers do not come from here. */
  | { readonly by: 'model' };

export interface Applied {
  readonly draft: ContractDraft;
  /** Guarded answers that were dropped, and why. Fed back as a tool result. */
  readonly refused: readonly string[];
}

/** Whitespace and case are formatting; a quote is about the words. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Does the interview file actually say this?
 *
 * A substring rather than a semantic match, deliberately. The check has to be
 * one a person can run themselves against the file they wrote, and one the
 * writer of the citation cannot argue with.
 */
export function cited(text: string, citation: string | undefined): boolean {
  if (citation === undefined || citation.trim() === '') {
    return false;
  }
  return normalize(text).includes(normalize(citation));
}

function refusal(field: Guarded, authorization: Authorization): string {
  if (authorization.by === 'model') {
    return `${field} is proposed, not recorded: put it to the user and record what they confirm`;
  }
  return `${field} is not stated in the interview file — quote the sentence that authorizes it, or the answer is missing`;
}

/**
 * Apply what was established, dropping any guarded answer that came unauthorized.
 *
 * Dropped rather than rejecting the patch wholesale: the rest of it is ordinary
 * answers, and losing them would make a model that overreached on one field
 * re-establish everything else.
 */
export function applyAnswers(
  draft: ContractDraft,
  patch: AnswerPatch,
  authorization: Authorization,
): Applied {
  const refused: string[] = [];

  /** What this patch authorizes a guarded answer with, if anything. */
  const granted = ((): Authority | undefined => {
    switch (authorization.by) {
      case 'human':
        return 'human';
      case 'project':
        return 'project';
      case 'file':
        return cited(authorization.text, patch.citation) ? 'file' : undefined;
      case 'model':
        return undefined;
    }
  })();

  const { securityEffect: proposed, ...ordinary } = patch.effects ?? {};
  const effects: EffectsDraft = { ...draft.effects, ...ordinary };
  const authority: { allowlist?: Authority; securityEffect?: Authority } = { ...draft.authority };

  let securityEffect = draft.effects?.securityEffect;
  if (proposed !== undefined) {
    if (granted === undefined) {
      refused.push(refusal('securityEffect', authorization));
    } else {
      securityEffect = proposed;
      authority.securityEffect = granted;
    }
  }

  let allowlist = draft.allowlist;
  if (patch.allowlist !== undefined) {
    if (granted === undefined) {
      refused.push(refusal('allowlist', authorization));
    } else {
      allowlist = patch.allowlist;
      authority.allowlist = granted;
    }
  }

  return {
    refused,
    draft: {
      ...draft,
      ...(patch.capability === undefined ? {} : { capability: patch.capability }),
      ...(patch.task === undefined ? {} : { task: patch.task }),
      ...(patch.entryPoint === undefined ? {} : { entryPoint: patch.entryPoint }),
      ...(patch.inputs === undefined ? {} : { inputs: patch.inputs }),
      ...(patch.output === undefined ? {} : { output: patch.output }),
      ...(patch.outcomes === undefined ? {} : { outcomes: patch.outcomes }),
      ...(patch.interactions === undefined ? {} : { interactions: patch.interactions }),
      ...(patch.budgetUsd === undefined ? {} : { budgetUsd: patch.budgetUsd }),
      // An unauthorized `securityEffect` leaves no value behind: a draft that
      // reads as answered with nothing authorizing it would make the gap report
      // the only place the difference was visible.
      effects: { ...effects, ...(securityEffect === undefined ? {} : { securityEffect }) },
      ...(allowlist === undefined ? {} : { allowlist }),
      authority,
    },
  };
}
