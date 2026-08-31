import { describe, expect, it } from 'vitest';

import {
  CONDITION_PARAM,
  DEFAULT_DELAY_MS,
  DELAY_PARAM,
  MAX_DELAY_MS,
  requestedCondition,
} from '@interfacer/fixtures';

/**
 * Parsing a requested condition is pure, so it is checked here rather than over
 * HTTP.
 *
 * That is not only tidiness. Asserting the delay clamp against a live server
 * would mean actually waiting out the clamped delay, once per fixture — the
 * test would spend seconds proving something a function call settles instantly.
 */

function url(query: string): URL {
  return new URL(`http://fixture.invalid/account?ref=ACC-1001${query}`);
}

describe('requestedCondition', () => {
  it('reports no condition when none is asked for', () => {
    expect(requestedCondition(url(''))).toEqual({
      condition: 'none',
      delayMs: DEFAULT_DELAY_MS,
    });
  });

  it.each(['session-expired', 'dialog', 'slow', 'app-error'])('recognises %s', (condition) => {
    expect(requestedCondition(url(`&${CONDITION_PARAM}=${condition}`)).condition).toBe(condition);
  });

  it('ignores a value it does not recognise', () => {
    // The parameter is a test affordance; failing on an unknown value would
    // turn a typo in a test into a confusing application failure.
    expect(requestedCondition(url(`&${CONDITION_PARAM}=nonsense`)).condition).toBe('none');
  });

  describe('the delay', () => {
    it('takes the requested number of milliseconds', () => {
      expect(requestedCondition(url(`&${DELAY_PARAM}=250`)).delayMs).toBe(250);
    });

    it('clamps a delay that would let a fixture hang', () => {
      // A test that wants to prove a timeout should assert against a
      // `.pauseUntil()` bound, not wait one out.
      expect(requestedCondition(url(`&${DELAY_PARAM}=99999999`)).delayMs).toBe(MAX_DELAY_MS);
    });

    it.each([
      ['a negative delay', '-1'],
      ['a non-numeric delay', 'soon'],
      ['an empty delay', ''],
    ])('falls back to the default for %s', (_name, value) => {
      expect(requestedCondition(url(`&${DELAY_PARAM}=${value}`)).delayMs).toBe(DEFAULT_DELAY_MS);
    });

    it('accepts zero, which is a request for no delay at all', () => {
      expect(requestedCondition(url(`&${DELAY_PARAM}=0`)).delayMs).toBe(0);
    });
  });
});
