/**
 * Pause and resume: suspend, let something outside the flow change the world,
 * resume after re-checking a precondition.
 *
 * Execution never sleeps for a fixed duration and hopes. It pauses on an
 * explicit resume predicate with a bound, and a duration only ever bounds how
 * long that predicate may stay false. `.wait(2000)` cannot distinguish "loaded
 * in 200ms" from "never loaded"; a predicate can.
 *
 * Waiting and human escalation are the **same primitive**, differing only in the
 * resolver — polling for `pauseUntil`, a human for the other three. That is why
 * there is one `Resolver` type rather than a callback per kind: the set of kinds
 * will grow, and caller policy ("deny every approval when unattended") then
 * lives in one place instead of three.
 *
 * The cost of one resolver is that the response type is not tied to the request
 * kind — nothing in the signature stops a caller answering an `approval` with a
 * string. {@link checkResponse} is the runtime check that buys that back, and a
 * mismatch is a hard failure. A per-kind callback would have made it a compile
 * error, at the price of triplicating the policy every caller has to write.
 */
import { isSecret, type Secret } from './secret.js';

/**
 * The kinds a human answers.
 *
 * `pauseUntil` is deliberately absent: it is resolved by polling, so there is
 * nobody to ask and no `InteractionRequest` to raise. Waiting on a surface is
 * not an interaction, which is what keeps "attended iff `interactions` is
 * non-empty" true.
 */
export type PauseKind = 'input' | 'approval' | 'operator';

export interface InteractionRequest {
  readonly kind: PauseKind;
  readonly name: string;
  readonly prompt: string;
  /** Whether the answer is a credential. `true` for every `input`. */
  readonly secret: boolean;
  /** ISO-8601. The bound, published to whoever is being asked. */
  readonly expiresAt: string;
}

/**
 * What an answer looks like — one type across all three kinds.
 *
 * `Secret<string>` answers an `input`, a boolean answers an `approval`, and
 * `'done'` answers an `operator` hand-back. An `input` answer is a `Secret`
 * whether or not the value is a credential: a value obtained mid-run has never
 * been through the field declarations, so nothing else would redact it.
 */
export type InteractionResponse = Secret | boolean | 'done';

export type Resolver = (request: InteractionRequest) => Promise<InteractionResponse>;

/**
 * A run that stopped to ask and had nowhere to ask.
 *
 * A control state, not a business outcome, and precisely what a caller gets when
 * no resolver is available.
 */
export interface Suspended {
  readonly status: 'suspended';
  readonly sessionId: string;
  readonly request: InteractionRequest;
}

export function isSuspended(value: unknown): value is Suspended {
  return (
    typeof value === 'object' && value !== null && 'status' in value && value.status === 'suspended'
  );
}

/** What a capability publishes about the pauses it declares. */
export interface InteractionDeclaration {
  readonly kind: PauseKind;
  readonly name: string;
  readonly prompt: string;
  readonly secret: boolean;
}

/**
 * A bound, written the way the design writes it: `'30s'`, `'500ms'`, `'2m'`.
 *
 * A plain number is milliseconds, which is what the engine works in.
 */
export type Duration = string | number;

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/;

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000 };

/**
 * Parse a bound into milliseconds.
 *
 * Throws rather than defaulting, and does so while the flow is being *built* —
 * a typo in a bound fails at construction rather than halfway through a run,
 * which is the only point at which it is cheap to notice.
 */
export function parseDuration(value: Duration): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid duration ${String(value)}: expected a non-negative number of ms`);
    }
    return value;
  }

  const match = DURATION.exec(value.trim());
  const unit = match?.[2];
  if (match === null || unit === undefined) {
    throw new Error(
      `invalid duration ${JSON.stringify(value)}: expected e.g. "500ms", "30s", "2m"`,
    );
  }

  return Number(match[1]) * (UNIT_MS[unit] ?? 1);
}

/**
 * How long a surface may take to arrive before the wait is a failure.
 *
 * A default rather than a required argument, because an unbounded pause is the
 * one thing that must not be expressible — but the number itself is a
 * convenience, and any flow that knows better says so with `within`.
 */
export const DEFAULT_SURFACE_BOUND_MS = 30_000;

/**
 * How long a human has to answer.
 *
 * Longer than a surface wait by two orders of magnitude, because the thing being
 * waited on is a person reading a phone rather than a page loading.
 */
export const DEFAULT_INTERACTION_BOUND_MS = 300_000;

/**
 * How long a parked run may sit before it is killed.
 *
 * Distinct from a pause bound: the bound is what the *flow* declares it will
 * wait, and the TTL is what the *process holding the browser* will tolerate. A
 * run parks only where there was nowhere to ask, so nothing guarantees anyone
 * will ever call `resume`, and a forgotten session must not strand a browser.
 */
export const DEFAULT_PARK_TTL_MS = 300_000;

/** The reason a pause of each kind is recorded under. */
export type PauseCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly expected: string; readonly observed: string };

/** How each kind must be answered, in words an error can carry. */
const EXPECTED: Readonly<Record<PauseKind, string>> = {
  input: 'a Secret<string>',
  approval: 'a boolean',
  operator: "the literal 'done'",
};

function describeResponse(response: InteractionResponse): string {
  if (isSecret(response)) {
    return 'a Secret';
  }
  return typeof response === 'boolean'
    ? `the boolean ${String(response)}`
    : `the string "${response}"`;
}

/**
 * Validate an answer against the kind that was asked.
 *
 * The engine treats a mismatch as a hard failure rather than coercing it. A
 * caller who answers an approval with a string has a bug in their policy, and
 * guessing which way they meant it — approve? deny? — is exactly the guess that
 * must not be made about an authorization.
 */
export function checkResponse(kind: PauseKind, response: InteractionResponse): PauseCheck {
  const ok =
    kind === 'input'
      ? isSecret(response)
      : kind === 'approval'
        ? typeof response === 'boolean'
        : response === 'done';

  return ok
    ? { ok: true }
    : { ok: false, expected: EXPECTED[kind], observed: describeResponse(response) };
}
