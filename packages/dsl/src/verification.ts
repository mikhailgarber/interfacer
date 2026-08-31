/**
 * Verification order — the most important algorithm in the engine, factored out
 * as a pure function so it is exhaustively testable instead of reachable only
 * through a browser.
 *
 * When a checkpoint or a postcondition is not satisfied, the engine does not
 * fail immediately. In order:
 *
 * 1. **Recover**, if the condition is one the flow knows. A declared interstitial
 *    is dismissed, a transient load is waited out, and the verification is
 *    retried up to its bound. These never reach the caller; they are recorded as
 *    evidence only.
 * 2. **Evaluate the declared outcome detectors**, in declaration order. The first
 *    match terminates the run with that outcome — a legitimate answer, returned
 *    rather than thrown.
 * 3. **Raise a hard failure**, only once nothing above matched.
 *
 * That order is the whole reason "no such account" is not a crash. Reversing
 * steps 2 and 3 would turn every business outcome into an exception, which is
 * the distinction the error taxonomy exists to preserve. Putting recovery first
 * matters too: a modal can hide both the checkpoint and the outcome banner, so
 * the page has to be legible before either can be judged.
 */

/**
 * A recovery the flow declares for the current page state.
 *
 * `null` means none applies. `attemptsRemaining` is the bound: recovery is not
 * an unbounded retry loop, and once it is spent the ladder continues to the
 * detectors rather than looping.
 */
export interface Recovery {
  readonly available: boolean;
  readonly attemptsRemaining: number;
}

export interface VerificationInput {
  /** Did the step's checkpoint or postcondition hold? */
  readonly satisfied: boolean;
  /**
   * Whether each declared outcome detector matched, **in declaration order**.
   * Order is the tie-break, so this is a list rather than a set.
   */
  readonly detectors: readonly boolean[];
  readonly recovery: Recovery | null;
}

export type VerificationDecision =
  /** The condition held. Carry on to the next step. */
  | { readonly action: 'proceed' }
  /** Dismiss or wait, then re-verify. Evidence only; never reaches the caller. */
  | { readonly action: 'recover'; readonly attemptsRemaining: number }
  /** A declared business outcome. Terminates the run, returned not thrown. */
  | { readonly action: 'outcome'; readonly index: number }
  /** Nothing above matched. Thrown as a typed exception. */
  | { readonly action: 'fail' };

/**
 * Decide what the engine does about one verification result.
 *
 * Note that the ladder runs only when the condition did **not** hold: a
 * satisfied checkpoint proceeds without consulting the detectors at all.
 */
export function decideVerification(input: VerificationInput): VerificationDecision {
  if (input.satisfied) {
    return { action: 'proceed' };
  }

  const { recovery } = input;
  if (recovery !== null && recovery.available && recovery.attemptsRemaining > 0) {
    return { action: 'recover', attemptsRemaining: recovery.attemptsRemaining };
  }

  const index = input.detectors.indexOf(true);
  if (index !== -1) {
    return { action: 'outcome', index };
  }

  return { action: 'fail' };
}
