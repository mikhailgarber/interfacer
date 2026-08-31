/**
 * Exceptional conditions, on demand.
 *
 * Each fixture can be asked to produce every exceptional condition, because a
 * suite that can only reach the happy path cannot test the verification order,
 * the retry gating or the error taxonomy at all.
 *
 * Two of them — a missing record and an insufficient role — need no trigger:
 * they fall out of the data, which is how a real application produces them. The
 * rest are asked for with an `_fx` query parameter on the request that should
 * exhibit them.
 *
 * A query parameter rather than a control endpoint, deliberately. An endpoint
 * that arms "the next request" is shared mutable state, and tests run in
 * parallel workers against the same server; a parameter is carried by the one
 * request it applies to and cannot be raced.
 */

export type Condition =
  | 'none'
  /** A session that was valid a moment ago no longer is. */
  | 'session-expired'
  /** A modal covering the content, hiding both checkpoints and outcome banners. */
  | 'dialog'
  /** A slow but successful response — distinguishable from one that never arrives. */
  | 'slow'
  /** The application itself failed: a 500 and an error screen. */
  | 'app-error';

export interface RequestedCondition {
  readonly condition: Condition;
  /** Only meaningful for `slow`. Bounded, so a test cannot hang on it. */
  readonly delayMs: number;
}

export const DEFAULT_DELAY_MS = 400;

/**
 * The longest delay a request may ask for.
 *
 * Bounded so a fixture cannot be made to hang: a test that wants to prove a
 * timeout should assert against a `.pauseUntil()` bound, not wait one out.
 */
export const MAX_DELAY_MS = 3_000;

const CONDITIONS = new Set<string>(['session-expired', 'dialog', 'slow', 'app-error']);

export const CONDITION_PARAM = '_fx';
export const DELAY_PARAM = '_ms';

/**
 * Read the condition a request is asking for.
 *
 * An unrecognized value is `none` rather than an error: the parameter is a test
 * affordance, and a fixture that 400s on an unknown one would turn a typo in a
 * test into a confusing application failure.
 */
export function requestedCondition(url: URL): RequestedCondition {
  const requested = url.searchParams.get(CONDITION_PARAM);
  const condition: Condition =
    requested !== null && CONDITIONS.has(requested) ? (requested as Condition) : 'none';

  return { condition, delayMs: requestedDelay(url) };
}

function requestedDelay(url: URL): number {
  const raw = url.searchParams.get(DELAY_PARAM);
  if (raw === null) {
    return DEFAULT_DELAY_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_DELAY_MS;
  }

  return Math.min(parsed, MAX_DELAY_MS);
}

/**
 * Carry the condition across a redirect.
 *
 * Without this, asking for a dialog on a POST that redirects would lose the
 * request before the screen that should show it — and the multi-step flows are
 * exactly where an interstitial is worth testing.
 */
export function withCondition(path: string, requested: RequestedCondition): string {
  if (requested.condition === 'none') {
    return path;
  }

  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${CONDITION_PARAM}=${requested.condition}`;
}
