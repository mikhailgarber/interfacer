/**
 * Replay-time enforcement of the `effects` declaration.
 *
 * Phase 5 landed the declaration and let `dataClasses` govern evidence. This is
 * the other half: a guardrail that is only established and never enforced is
 * documentation, so the two dimensions the design says drive an enforcement do
 * drive one, here, before the dangerous step runs.
 *
 * Enforcement keys off the individual dimensions rather than a rolled-up risk
 * score, which would lose the ability to say that "read-only but touches
 * everything" is fine:
 *
 * * `reversible: 'no'` — an approval must have been granted before the
 *   `.commit()`. The harm is permanent, so a human has to have seen it.
 * * `securityEffect` other than `'none'` — approval *and* an attended session.
 *   Changing a password is `write`, `reversible` and single-step, and is the
 *   last move of taking over an account; the dimension exists because the others
 *   score that as low risk.
 *
 * The remaining three dimensions — `scope`, `external`, `financial` — are
 * declared and published but deliberately not enforced, each needing machinery
 * nothing else in this design uses. They are absent here on purpose rather than
 * forgotten.
 *
 * Generation-*time* rejections (a `read` capability containing a `.commit()`)
 * belong to the generator in Phase 7, not to this module: they are a property of
 * the artifact, and catching them at replay would be catching them once per run
 * instead of once.
 */
import type { Effects } from './effects.js';
import type { Step } from './flow.js';

/**
 * Whether the declaration demands a human before the point of no return.
 *
 * Exported because the same predicate answers two questions at two different
 * times — *can this flow ever satisfy its declaration* before a browser opens,
 * and *did this run actually obtain an approval* at the commit itself — and the
 * generator will ask it a third time when it writes what a caller may expect.
 */
export function requiresApproval(effects: Effects): boolean {
  return effects.reversible === 'no' || effects.securityEffect !== 'none';
}

/** The rules a flow can fail, named so a record says which one refused it. */
export type SafetyRule =
  /** `reversible: 'no'` reached a `.commit()` no approval preceded. */
  | 'irreversible-requires-approval'
  /** A `securityEffect` capability that never asks a human anything. */
  | 'security-effect-requires-approval'
  /** A `securityEffect` capability asked to run with nobody watching. */
  | 'security-effect-requires-attended';

/**
 * A refusal, in the shape a `ReplayError` and an `error` entry both want.
 *
 * `step` is the step the rule failed at where there is one — the unapproved
 * commit — and the flow id where the failure is a property of the whole flow.
 */
export interface SafetyViolation {
  readonly rule: SafetyRule;
  readonly step: string;
  readonly expected: string;
  readonly observed: string;
}

/** What the rules need to see: the declaration, and the shape of the flow. */
export interface SafetySubject {
  readonly id: string;
  readonly effects: Effects;
  readonly steps: readonly Step[];
}

export interface SafetyConditions {
  /**
   * Whether the run was asked for headless.
   *
   * The option rather than the browser, because Playwright exposes no way to ask
   * a `Browser` whether it was launched headed — so a caller passing its own
   * browser is taken at its word.
   */
  readonly headless: boolean;
}

/**
 * The first rule the flow fails, or `undefined` if it satisfies all of them.
 *
 * Checked before a browser opens, because a flow that provably cannot satisfy
 * its own declaration should not get as far as logging in: half a run that ends
 * at the commit is safe but wasteful, and the reason is knowable from the
 * artifact alone.
 *
 * One violation rather than a list: the error it becomes carries a single
 * expected/observed pair, and inventing a plural form of that to report rules a
 * fixed flow might also fail is a worse trade than reporting them one at a time.
 */
export function checkSafety(
  subject: SafetySubject,
  conditions: SafetyConditions,
): SafetyViolation | undefined {
  const { effects } = subject;

  if (effects.securityEffect !== 'none' && conditions.headless) {
    return {
      rule: 'security-effect-requires-attended',
      step: subject.id,
      expected: `a headed session: securityEffect is ${JSON.stringify(effects.securityEffect)}`,
      observed: 'headless',
    };
  }

  if (!requiresApproval(effects)) {
    return undefined;
  }

  // Walk the flow the way the engine will. An approval authorizes *the step that
  // follows* — that is what the flow is asking a human when it stops — so it is
  // spent by the commit it precedes, and a second commit needs a second
  // approval. One approval standing for every irreversible action in a run would
  // authorize things the approver was never shown.
  let approved = false;
  let commits = 0;

  for (const step of subject.steps) {
    if (step.kind === 'pause' && step.pauseKind === 'approval') {
      approved = true;
      continue;
    }

    if (step.kind !== 'commit') {
      continue;
    }

    commits += 1;
    if (!approved) {
      return {
        rule: 'irreversible-requires-approval',
        step: step.id,
        expected:
          effects.reversible === 'no'
            ? 'an approval pause before the commit: reversible is "no"'
            : `an approval pause before the commit: securityEffect is ${JSON.stringify(effects.securityEffect)}`,
        observed: 'the commit is not preceded by an unspent approval',
      };
    }
    approved = false;
  }

  if (commits === 0 && effects.securityEffect !== 'none' && !approved) {
    // "Anything but none forces approval" is about the capability, not about a
    // particular step: a flow that changes who can access an account and never
    // asks anybody has not been authorized, whether or not it named one of its
    // presses a `.commit()`.
    return {
      rule: 'security-effect-requires-approval',
      step: subject.id,
      expected: `an approval pause: securityEffect is ${JSON.stringify(effects.securityEffect)}`,
      observed: 'the flow declares none',
    };
  }

  return undefined;
}
