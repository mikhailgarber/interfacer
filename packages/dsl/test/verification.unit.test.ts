import { describe, expect, it } from 'vitest';

import {
  decideVerification,
  type Recovery,
  type VerificationDecision,
  type VerificationInput,
} from '@interfacer/dsl';

/**
 * The verification order is the most important algorithm in the engine, and the
 * reason it is a pure function is so it can be checked exhaustively here rather
 * than only through a browser.
 *
 * Two kinds of test below. The exhaustive sweep proves the ordering holds across
 * the whole bounded input space. The named cases pin the *reasons* the design
 * gives for that ordering, so a future edit that reverses two rungs fails with a
 * message saying which property it broke, not just "expected fail, got outcome".
 */

const RECOVERIES: readonly (Recovery | null)[] = [
  null,
  { available: false, attemptsRemaining: 0 },
  { available: false, attemptsRemaining: 3 },
  { available: true, attemptsRemaining: 0 },
  { available: true, attemptsRemaining: 1 },
  { available: true, attemptsRemaining: 3 },
];

/** Every boolean array of length 0 through 3 — 15 detector configurations. */
function detectorConfigurations(maxLength: number): boolean[][] {
  const all: boolean[][] = [[]];

  for (let length = 1; length <= maxLength; length++) {
    for (let bits = 0; bits < 2 ** length; bits++) {
      all.push(Array.from({ length }, (_, index) => (bits & (1 << index)) !== 0));
    }
  }

  return all;
}

function everyInput(): VerificationInput[] {
  const inputs: VerificationInput[] = [];

  for (const satisfied of [true, false]) {
    for (const recovery of RECOVERIES) {
      for (const detectors of detectorConfigurations(3)) {
        inputs.push({ satisfied, detectors, recovery });
      }
    }
  }

  return inputs;
}

function canRecover(recovery: Recovery | null): boolean {
  return recovery !== null && recovery.available && recovery.attemptsRemaining > 0;
}

function describeInput(input: VerificationInput): string {
  return JSON.stringify(input);
}

describe('decideVerification', () => {
  const inputs = everyInput();

  it('sweeps the whole bounded input space', () => {
    // 2 satisfied x 6 recoveries x 15 detector configurations.
    expect(inputs).toHaveLength(180);
  });

  it('returns exactly one decision for every input', () => {
    const actions = new Set(inputs.map((input) => decideVerification(input).action));

    expect([...actions].sort()).toEqual(['fail', 'outcome', 'proceed', 'recover']);
  });

  describe('rung 0 — a satisfied condition short-circuits the ladder', () => {
    it.each(
      inputs.filter((input) => input.satisfied).map((input) => [describeInput(input), input]),
    )('proceeds: %s', (_label, input) => {
      // Note what this also asserts: a satisfied checkpoint proceeds without
      // consulting the detectors at all, even when one of them would match.
      expect(decideVerification(input)).toEqual({ action: 'proceed' });
    });
  });

  describe('rung 1 — recovery, before anything is judged', () => {
    const recoverable = inputs.filter((input) => !input.satisfied && canRecover(input.recovery));

    it.each(recoverable.map((input) => [describeInput(input), input]))(
      'recovers: %s',
      (_label, input) => {
        const typed = input;
        const decision = decideVerification(typed);

        // Recovery wins over a matching detector. A modal can hide both the
        // checkpoint and the outcome banner, so the page has to be legible
        // before either can be judged.
        expect(decision).toEqual({
          action: 'recover',
          attemptsRemaining: typed.recovery?.attemptsRemaining,
        });
      },
    );

    it('stops recovering once the bound is spent', () => {
      const spent: VerificationInput = {
        satisfied: false,
        detectors: [],
        recovery: { available: true, attemptsRemaining: 0 },
      };

      // Not a loop: an exhausted bound falls through to the next rung rather
      // than retrying forever.
      expect(decideVerification(spent)).toEqual({ action: 'fail' });
    });
  });

  describe('rung 2 — declared outcomes, in declaration order', () => {
    const outcomes = inputs.filter(
      (input) => !input.satisfied && !canRecover(input.recovery) && input.detectors.includes(true),
    );

    it.each(outcomes.map((input) => [describeInput(input), input]))(
      'returns the first match: %s',
      (_label, input) => {
        const typed = input;

        expect(decideVerification(typed)).toEqual({
          action: 'outcome',
          index: typed.detectors.indexOf(true),
        });
      },
    );

    it('takes the earlier of two matching detectors', () => {
      // Declaration order is the tie-break, which is why detectors are a list
      // and not a set.
      expect(
        decideVerification({ satisfied: false, detectors: [true, true], recovery: null }),
      ).toEqual({ action: 'outcome', index: 0 });
    });
  });

  describe('rung 3 — hard failure, only once nothing above matched', () => {
    const failures = inputs.filter(
      (input) => !input.satisfied && !canRecover(input.recovery) && !input.detectors.includes(true),
    );

    it.each(failures.map((input) => [describeInput(input), input]))(
      'fails: %s',
      (_label, input) => {
        expect(decideVerification(input)).toEqual({ action: 'fail' });
      },
    );
  });

  describe('the properties the ordering exists to preserve', () => {
    it('returns "no such account" rather than throwing it', () => {
      // The whole reason for the ordering. Reversing rungs 2 and 3 would turn
      // every business outcome into an exception, which is precisely the
      // distinction the error taxonomy exists to preserve.
      const noSuchAccount: VerificationInput = {
        satisfied: false,
        detectors: [true],
        recovery: null,
      };

      expect(decideVerification(noSuchAccount).action).toBe('outcome');
      expect(decideVerification(noSuchAccount).action).not.toBe('fail');
    });

    it('makes a state with no detector a hard failure', () => {
      // The other half of the pair. Phase 3 drives a fixture into a declared
      // outcome, then removes the detector and asserts the same state fails —
      // this is that assertion at the level of the decision procedure.
      const undeclared: VerificationInput = {
        satisfied: false,
        detectors: [false],
        recovery: null,
      };

      expect(decideVerification(undeclared)).toEqual({ action: 'fail' });
    });

    it('never reports an outcome index that is not a match', () => {
      for (const input of inputs) {
        const decision: VerificationDecision = decideVerification(input);

        if (decision.action === 'outcome') {
          expect(input.detectors[decision.index], describeInput(input)).toBe(true);
        }
      }
    });

    it('never recovers when no recovery is available', () => {
      for (const input of inputs) {
        if (decideVerification(input).action === 'recover') {
          expect(canRecover(input.recovery), describeInput(input)).toBe(true);
        }
      }
    });
  });
});
