/**
 * Cost accounting for the discovery budget.
 *
 * An unattended run needs a spending bound, since nothing is watching it. The
 * budget is expressed as **cost**, because that is the only unit meaningful to
 * whoever authorized the run — and Interfacer accumulates spend from the `usage`
 * on every response, counting cached and uncached input at their own rates,
 * since discovery resends history constantly and cache reads are an order of
 * magnitude cheaper than fresh input.
 *
 * Nothing here reaches a generated capability: replay never calls a model, so it
 * never spends anything.
 */

/** The token counts a provider reports for one response. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input served from cache — cheap, and most of discovery's input. */
  readonly cacheReadInputTokens?: number;
  /** Input written into the cache — dearer than fresh input. */
  readonly cacheCreationInputTokens?: number;
}

/** US dollars per million tokens. */
export interface ModelRates {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
}

/**
 * Accumulated token counts.
 *
 * Tokens rather than dollars, so accumulation is exact integer arithmetic and
 * the conversion to money happens once, at the point a ceiling is compared.
 */
export interface Spend {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** How many model responses were counted, which is what a stall guard reads. */
  readonly turns: number;
}

export const ZERO_SPEND: Spend = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  turns: 0,
});

function assertCountable(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    // A negative or NaN count would silently reduce accumulated spend and let a
    // run slip under a ceiling it had already passed. The harness holds the hard
    // cap, so the harness refuses to be lied to.
    throw new TypeError(`${name} must be a non-negative finite number, got ${String(value)}`);
  }
}

function countsOf(usage: Usage): Required<Usage> {
  const counts = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
  };

  for (const [name, value] of Object.entries(counts)) {
    assertCountable(name, value);
  }

  return counts;
}

/** What one response cost, in US dollars. */
export function costOf(usage: Usage, rates: ModelRates): number {
  const counts = countsOf(usage);

  return (
    (counts.inputTokens * rates.inputPerMTok +
      counts.outputTokens * rates.outputPerMTok +
      counts.cacheReadInputTokens * rates.cacheReadPerMTok +
      counts.cacheCreationInputTokens * rates.cacheWritePerMTok) /
    1_000_000
  );
}

/** Fold one response's usage into the running total. */
export function addUsage(spend: Spend, usage: Usage): Spend {
  const counts = countsOf(usage);

  return Object.freeze({
    inputTokens: spend.inputTokens + counts.inputTokens,
    outputTokens: spend.outputTokens + counts.outputTokens,
    cacheReadInputTokens: spend.cacheReadInputTokens + counts.cacheReadInputTokens,
    cacheCreationInputTokens: spend.cacheCreationInputTokens + counts.cacheCreationInputTokens,
    turns: spend.turns + 1,
  });
}

/** What the accumulated spend has cost, in US dollars. */
export function spendCost(spend: Spend, rates: ModelRates): number {
  return costOf(spend, rates);
}

/**
 * Published rates, as of 2026-06.
 *
 * The model id is configuration, not a constant, so this is a convenience for
 * the models Interfacer defaults to — not a closed set. {@link ratesFor} returns
 * `undefined` for anything else, and a caller must treat that as "cannot account
 * for spend" rather than as zero: a budget that silently reads as unspent is the
 * same failure as a default nobody chose.
 */
export const KNOWN_MODEL_RATES: Readonly<Record<string, ModelRates>> = Object.freeze({
  'claude-opus-5': Object.freeze({
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  }),
  'claude-sonnet-5': Object.freeze({
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  }),
});

export function ratesFor(modelId: string): ModelRates | undefined {
  // `hasOwn`, not a plain index: a model id of `toString` or `constructor` would
  // otherwise resolve to something off `Object.prototype` and be billed as if it
  // were a rate table.
  return Object.hasOwn(KNOWN_MODEL_RATES, modelId) ? KNOWN_MODEL_RATES[modelId] : undefined;
}
