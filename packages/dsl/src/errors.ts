/**
 * Hard failures.
 *
 * Errors are categorized by who needs to act on them, and each category surfaces
 * through a different mechanism. A **business outcome** is a legitimate answer
 * and comes back as a member of the result union, never thrown. A **recoverable**
 * condition is handled inside the DSL and reaches the caller only as evidence.
 * What is left — the flow could not continue and no declared outcome matched — is
 * thrown, and this is what it is thrown as.
 *
 * Every one carries the step id, what was expected, what was observed, and the
 * run id that locates the rest in the record.
 */

export interface ReplayErrorDetail {
  readonly runId: string;
  /** e.g. `login.submit`. Stable across edits to the flow. */
  readonly step: string;
  readonly expected: string;
  readonly observed: string;
}

export class ReplayError extends Error implements ReplayErrorDetail {
  readonly runId: string;
  readonly step: string;
  readonly expected: string;
  readonly observed: string;

  constructor(message: string, detail: ReplayErrorDetail) {
    super(message);
    this.name = new.target.name;
    this.runId = detail.runId;
    this.step = detail.step;
    this.expected = detail.expected;
    this.observed = detail.observed;
  }
}

/** A checkpoint or postcondition never held, and no declared outcome matched. */
export class CheckpointFailed extends ReplayError {}

/**
 * A target matched more than one element.
 *
 * Never "take the first". Two elements answering to the same description means
 * the recorded intent is no longer unambiguous, and acting on either is a guess.
 */
export class TargetAmbiguous extends ReplayError {}

/**
 * A navigation left the replay allowlist.
 *
 * The replay list is computed rather than confirmed, and is strictly tighter
 * than discovery's, so leaving it is not a policy question — it means the
 * application changed. Judged on the **resolved** URL, because an allowed host
 * can redirect off-list.
 */
export class NavigationBlocked extends ReplayError {}

/** The surface could not be reached at all: the page failed to load. */
export class SurfaceUnavailable extends ReplayError {}

/**
 * The session ended mid-flow.
 *
 * Part of the taxonomy, and nothing throws it yet: distinguishing "the session
 * expired" from "a checkpoint failed" needs a rule about what a login screen
 * looks like, which belongs to a flow rather than to the engine. A flow that
 * cares declares it as an `.outcome()` today.
 */
export class SessionExpired extends ReplayError {}

/**
 * A bounded pause elapsed with nobody answering.
 *
 * Every pause is bounded, so an escalation nobody answers becomes a hard failure
 * with evidence rather than a hang. Used for `awaiting-surface`,
 * `awaiting-input` and `awaiting-action`; an unanswered approval is an
 * {@link ApprovalDenied} instead, because silence is not consent.
 */
export class PauseExpired extends ReplayError {}

/**
 * An approval was refused, or went unanswered until its bound elapsed.
 *
 * Expiry and refusal are the same class deliberately: the design says an
 * approval that expires is *treated as a deny*, and giving silence its own error
 * would invite a caller to handle it as something other than a refusal.
 */
export class ApprovalDenied extends ReplayError {}

/**
 * A resolver answered with something the kind it was asked did not admit.
 *
 * One `Resolver` serves every kind, so the response type cannot be tied to the
 * request kind at compile time. This is the runtime check that buys that back.
 */
export class InteractionFailed extends ReplayError {}

/**
 * `resume` was called with an id that names no parked run.
 *
 * Not a {@link ReplayError}: there is no run to attribute it to. It is either a
 * second `resume` on an id — resume is single-shot — or an id whose run has
 * already finished, expired, or belonged to a different process. Parked runs are
 * held in memory beside a live browser, so an id is a handle to a process rather
 * than a key anybody else could look up.
 */
export class UnknownSession extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`no parked run for session ${JSON.stringify(sessionId)}`);
    this.name = new.target.name;
    this.sessionId = sessionId;
  }
}

/**
 * Exported because TypeScript types a `catch` binding as `unknown` and has no
 * `throws` clause. Without the guard, consumers lose the typing at the one place
 * they need it.
 */
export function isReplayError(error: unknown): error is ReplayError {
  return error instanceof ReplayError;
}
