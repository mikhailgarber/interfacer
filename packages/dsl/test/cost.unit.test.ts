import { describe, expect, it } from 'vitest';

import {
  addUsage,
  costOf,
  ratesFor,
  spendCost,
  ZERO_SPEND,
  type ModelRates,
  type Usage,
} from '@interfacer/dsl';

/** Round numbers, so an arithmetic slip is visible rather than plausible. */
const RATES: ModelRates = {
  inputPerMTok: 10,
  outputPerMTok: 100,
  cacheReadPerMTok: 1,
  cacheWritePerMTok: 20,
};

// @covers agent.spend-counts-cache-rates
describe('costOf', () => {
  it('charges each input class at its own rate', () => {
    // The whole point of tracking the classes separately: discovery resends
    // history constantly, so most input is a cache read at a tenth the price.
    // Collapsing them into one "input tokens" figure would overstate spend by
    // an order of magnitude and blow a budget that was never actually spent.
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };

    expect(costOf(usage, RATES)).toBe(10 + 100 + 1 + 20);
  });

  it('treats absent cache counts as zero', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 0 }, RATES)).toBe(10);
  });

  it('costs nothing for no tokens', () => {
    expect(costOf({ inputTokens: 0, outputTokens: 0 }, RATES)).toBe(0);
  });

  it('scales linearly below a million tokens', () => {
    expect(costOf({ inputTokens: 250_000, outputTokens: 0 }, RATES)).toBeCloseTo(2.5, 10);
  });

  describe('refuses a count it cannot trust', () => {
    it.each([
      ['a negative input count', { inputTokens: -1, outputTokens: 0 }],
      ['a negative output count', { inputTokens: 0, outputTokens: -5 }],
      ['a negative cache read', { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: -1 }],
      ['NaN', { inputTokens: Number.NaN, outputTokens: 0 }],
      ['Infinity', { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 }],
    ])('throws on %s', (_name, usage) => {
      // A negative count would silently reduce accumulated spend and let a run
      // slip under a ceiling it had already passed. The harness holds the hard
      // cap, so the harness refuses to be lied to.
      expect(() => costOf(usage as Usage, RATES)).toThrow(TypeError);
    });
  });
});

describe('addUsage', () => {
  it('accumulates every class, and counts turns', () => {
    const first: Usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 50,
    };
    const second: Usage = { inputTokens: 200, outputTokens: 20 };

    const spend = addUsage(addUsage(ZERO_SPEND, first), second);

    expect(spend).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 50,
      turns: 2,
    });
  });

  it('does not mutate the spend it was given', () => {
    addUsage(ZERO_SPEND, { inputTokens: 1, outputTokens: 1 });

    expect(ZERO_SPEND.inputTokens).toBe(0);
    expect(ZERO_SPEND.turns).toBe(0);
  });

  it('accumulates tokens exactly, so cost is converted once', () => {
    // Tokens are integers; dollars are not. Accumulating money instead would
    // drift, and a budget check reads the total, not any single turn.
    let spend = ZERO_SPEND;
    for (let turn = 0; turn < 1000; turn++) {
      spend = addUsage(spend, { inputTokens: 3, outputTokens: 7 });
    }

    expect(spend.inputTokens).toBe(3000);
    expect(spend.outputTokens).toBe(7000);
    expect(spend.turns).toBe(1000);
    expect(spendCost(spend, RATES)).toBeCloseTo((3000 * 10 + 7000 * 100) / 1_000_000, 12);
  });

  it('rejects a bad usage before it reaches the total', () => {
    expect(() => addUsage(ZERO_SPEND, { inputTokens: -1, outputTokens: 0 })).toThrow(TypeError);
  });
});

describe('ratesFor', () => {
  it('knows the model Interfacer defaults to', () => {
    expect(ratesFor('claude-opus-5')).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    });
  });

  it('returns undefined for a model it has no rates for', () => {
    // Deliberately not a zero-rate fallback. A budget that silently reads as
    // unspent is the same failure as a default nobody chose: the caller has to
    // decide what to do about a model it cannot price.
    expect(ratesFor('some-model-shipped-next-year')).toBeUndefined();
  });

  it('does not resolve inherited object properties as models', () => {
    expect(ratesFor('toString')).toBeUndefined();
    expect(ratesFor('constructor')).toBeUndefined();
  });
});
