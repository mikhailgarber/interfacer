import { describe, expect, it } from 'vitest';

import {
  byLabel,
  byRole,
  byText,
  css,
  describeTarget,
  incidentalSelector,
  isBestFirst,
  namesOf,
  strategyRank,
  STRATEGY_PREFERENCE,
  type TargetChain,
} from '@interfacer/dsl';

// @covers scope.target-names-own-strategy
describe('Target', () => {
  it('names its own strategy rather than being an opaque selector', () => {
    // The whole abstraction that keeps other surfaces reachable: a recorded flow
    // says "the control identified this way", so a strategy resolving against a
    // desktop accessibility tree later is additive.
    expect(byRole('button', 'Sign in')).toEqual({ by: 'role', role: 'button', name: 'Sign in' });
    expect(byLabel('Username')).toEqual({ by: 'label', text: 'Username' });
    expect(byText('No such account')).toEqual({ by: 'text', text: 'No such account' });
    expect(css('#balance-value')).toEqual({ by: 'css', selector: '#balance-value' });
  });

  it('omits an absent role name rather than storing undefined', () => {
    expect(Object.hasOwn(byRole('button'), 'name')).toBe(false);
  });

  it('freezes targets, so a recorded flow cannot be edited in place', () => {
    expect(Object.isFrozen(byRole('button', 'Sign in'))).toBe(true);
  });
});

// @covers target.preference-order
describe('the selectors the design excludes outright', () => {
  it.each([
    ['dl dd:nth-of-type(1)', 'positional'],
    ['main > div:nth-child(3) span', 'positional'],
    ['tr:first-child td', 'positional'],
    ['ul li:last-of-type', 'positional'],
    // The generated class names `hostile` actually serves. A hash in a class is
    // a build artifact: it survives nothing, not even a rebuild of the same
    // source.
    ['.css-4b8a1e', 'generated'],
    ['.css-1x2y3z button', 'generated'],
    ['._q3Wm1', 'generated'],
    ['div._a7Bq9x > span', 'generated'],
  ])('rejects %s as %s', (selector, why) => {
    expect(incidentalSelector(selector)).toContain(why);
  });

  it.each([
    '#balance-value',
    '[data-testid="balance"]',
    'button[type="submit"]',
    'input[name="username"]',
    '.error-banner',
    '.col-md-6',
    'main dd',
  ])('admits %s, which names something rather than counting to it', (selector) => {
    expect(incidentalSelector(selector)).toBeUndefined();
  });

  it('is a judgement about the selector, not a restriction on css()', () => {
    // `css()` keeps taking anything: a hand-written flow may need a positional
    // path as a genuine last resort, and the design's floor is that on a page
    // with no semantic markup css is all there is. What this decides is what
    // *discovery* is allowed to record, where a model has the whole page to
    // choose from and a weak target would be a choice rather than a floor.
    expect(css('dl dd:nth-of-type(1)')).toEqual({
      by: 'css',
      selector: 'dl dd:nth-of-type(1)',
    });
  });
});

// @covers target.preference-order target.chain-recorded-best-first
describe('strategy preference', () => {
  it('ranks what a control is above where it sits', () => {
    // `role` and `label` describe what a control is and what an operator calls
    // it, and both come from the accessibility tree. `css` is last because it
    // describes position in a document, which any re-render can change.
    expect(STRATEGY_PREFERENCE).toEqual(['role', 'label', 'text', 'css']);
  });

  it.each([
    [byRole('button'), 0],
    [byLabel('Username'), 1],
    [byText('Balance'), 2],
    [css('#x'), 3],
  ])('ranks %o at %i', (target, rank) => {
    expect(strategyRank(target)).toBe(rank);
  });

  describe('isBestFirst', () => {
    it('accepts a chain recorded best-first', () => {
      const chain: TargetChain = [byLabel('Current balance'), css('#balance-value')];

      expect(isBestFirst(chain)).toBe(true);
    });

    it('accepts a chain of equal-ranked strategies', () => {
      // Two accessible-name spellings recorded side by side is not disorder.
      expect(isBestFirst([byLabel('Member ID'), byLabel('Customer ID')])).toBe(true);
    });

    it('rejects a chain that leads with the weakest strategy', () => {
      // If the chain is not ordered, the fallback signal means nothing: "a
      // weaker strategy carried it" only reads as drift if the stronger one was
      // genuinely tried first.
      expect(isBestFirst([css('#login_field'), byLabel('Username')])).toBe(false);
    });

    it('accepts a single-strategy chain', () => {
      // The honest floor: on a page with no semantic markup, `css` is all there
      // is, and no strategy makes that robust. What the chain buys there is not
      // robustness but detection.
      expect(isBestFirst([css('#balance')])).toBe(true);
    });
  });
});

// @covers target.alternatives-for-names-only
describe('accessible names', () => {
  it('admits alternatives for a role name', () => {
    // One institution says "Member" where another says "Customer". This absorbs
    // the wording tier without becoming a general per-tenant override layer.
    expect(namesOf(byRole('button', ['Sign in', 'Log in']))).toEqual(['Sign in', 'Log in']);
  });

  it('admits alternatives for a label', () => {
    expect(namesOf(byLabel(['Member ID', 'Customer ID']))).toEqual(['Member ID', 'Customer ID']);
  });

  it('reports a single name as a one-element list', () => {
    expect(namesOf(byRole('button', 'Sign in'))).toEqual(['Sign in']);
  });

  it('reports no name where a strategy carries none', () => {
    expect(namesOf(byRole('button'))).toEqual([]);
    // A CSS selector is a position, not a name — which is the reason it ranks
    // last, and the reason branding changes do not affect the ranks above it.
    expect(namesOf(css('#balance'))).toEqual([]);
  });
});

describe('describeTarget', () => {
  it.each([
    [byRole('button', 'Sign in'), 'role=button name="Sign in"'],
    [byRole('button'), 'role=button'],
    [byRole('button', ['Sign in', 'Log in']), 'role=button name=["Sign in" | "Log in"]'],
    [byLabel('Username'), 'label="Username"'],
    [byText('No such account'), 'text="No such account"'],
    [css('#balance-value'), 'css="#balance-value"'],
  ])('renders %o', (target, rendered) => {
    // Errors and evidence refer to a step by a stable id; this is the other half
    // of a legible failure — what the step was looking for.
    expect(describeTarget(target)).toBe(rendered);
  });
});
