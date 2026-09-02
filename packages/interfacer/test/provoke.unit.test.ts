import { answer, byRole, byText, field, fields, Flow, text } from '@interfacer/dsl';
import { provokeOutcomes } from 'interfacer';
import { describe, expect, it } from 'vitest';

/**
 * What provocation does about an outcome discovery already found.
 *
 * The guard exists so a state discovery passed through on its way to the goal
 * is not paid for twice. It compared step ids, and an outcome's step id is
 * derived from its target unless one is given — so it matched the contract's
 * outcome id only by accident, and a real run declared `account_not_found`
 * twice with two different detectors.
 *
 * No browser and no model here on purpose: if the guard works, neither is
 * reached, so a `decide` that throws is the assertion.
 */

const input = fields({ url: text(), accountRef: text() });

const NOT_FOUND = { id: 'account_not_found', description: 'no account with that reference' };

/** A flow carrying the arm discovery declares: no explicit id, so it derives one. */
function alreadyDeclared() {
  return new Flow({ id: 'balanceLookup', input })
    .open(field('url'), { id: 'open' })
    .outcome(
      [byRole('heading', 'No such account'), byText('No such account')],
      answer('account_not_found', { accountRef: field('accountRef') }),
    );
}

const REFUSE = {
  decide: () => {
    throw new Error('provocation ran when the outcome was already declared');
  },
  live: {},
};

describe('an outcome discovery already declared', () => {
  it('is taken as verified without being provoked again', async () => {
    const flow = alreadyDeclared();
    // The derived id is nothing like the contract's outcome id, which is the
    // whole bug: `outcome:role=heading name="No such account"` never equals
    // `account_not_found`.
    expect(flow.outcomes[0]?.id).not.toBe(NOT_FOUND.id);

    const provocations = await provokeOutcomes(flow, [NOT_FOUND], REFUSE);

    expect(provocations.provoked).toEqual([{ outcome: NOT_FOUND, verified: true }]);
    // And no second arm: two arms for one status is one detector too many, and
    // the second shadows the first at replay.
    expect(flow.outcomes).toHaveLength(1);
  });
});
