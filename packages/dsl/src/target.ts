/**
 * How a control is identified.
 *
 * Every step that touches the page names a control, and so does every checkpoint
 * and every business-outcome detector. All three use this one type, so there is
 * a single answer to "how is this identified" rather than three.
 *
 * A target is never an opaque selector string but a structured value that names
 * its own strategy. That is the whole abstraction keeping other surfaces
 * reachable: a recorded flow says "the control identified this way", so
 * introducing a strategy that resolves against a desktop accessibility tree
 * later is purely additive, and no existing artifact needs rewriting.
 */

/**
 * An accessible name, optionally admitting alternatives.
 *
 * Alternatives exist for exactly one reason: one institution says "Member" where
 * another says "Customer", and that wording tier is the bulk of what tenants
 * differ by. They are admitted for an accessible *name* and nothing else — a
 * target that could vary its strategy or its structure per tenant would be an
 * override layer wearing a different hat, which the design rejects.
 */
export type AccessibleName = string | readonly string[];

export type Target =
  | { readonly by: 'role'; readonly role: string; readonly name?: AccessibleName }
  | { readonly by: 'label'; readonly text: AccessibleName }
  | { readonly by: 'text'; readonly text: string }
  | { readonly by: 'css'; readonly selector: string };

export type Strategy = Target['by'];

/** A target is recorded as an ordered chain of strategies, best-first. */
export type TargetChain = readonly [Target, ...Target[]];

/**
 * Preference order, and the reasoning behind it.
 *
 * `role` and `label` describe what a control *is* and what an operator calls it;
 * both come from the accessibility tree, which is also the representation a
 * desktop surface would expose. `text` is next. `css` is last, because it
 * describes where a control sits in a document rather than what it does.
 */
export const STRATEGY_PREFERENCE = [
  'role',
  'label',
  'text',
  'css',
] as const satisfies readonly Strategy[];

export function byRole(role: string, name?: AccessibleName): Target {
  return Object.freeze(name === undefined ? { by: 'role', role } : { by: 'role', role, name });
}

export function byLabel(text: AccessibleName): Target {
  return Object.freeze({ by: 'label', text });
}

export function byText(text: string): Target {
  return Object.freeze({ by: 'text', text });
}

export function css(selector: string): Target {
  return Object.freeze({ by: 'css', selector });
}

/** Lower is preferred. */
export function strategyRank(target: Target): number {
  return STRATEGY_PREFERENCE.indexOf(target.by);
}

/** Selectors that count to an element rather than naming it. */
const POSITIONAL =
  /:(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|first-of-type|last-of-type|only-child|only-of-type)\b/;

/** Class tokens, once quoted attribute values are out of the way. */
const CLASS_TOKEN = /\.(-?[A-Za-z_][\w-]*)/g;

/**
 * Whether a class token looks like a build artifact rather than a name.
 *
 * A hashed segment is the tell: `css-4b8a1e`, `_q3Wm1`, `sc-1x2y3z`. Judged per
 * `-`/`_` segment so that ordinary compound names — `error-banner`, `col-md-6`
 * — are left alone; a segment has to be long enough to be a hash and mix
 * letters with digits, which a word does not.
 */
function looksGenerated(token: string): boolean {
  const segments = token.split(/[-_]/).filter((segment) => segment !== '');
  return segments.some(
    (segment) => segment.length >= 4 && /[A-Za-z]/.test(segment) && /\d/.test(segment),
  );
}

/**
 * Why a selector encodes incidental structure, or `undefined` where it does not.
 *
 * The design excludes generated class names and positional paths outright:
 * they encode incidental structure and break on any re-render. `css()` still
 * accepts them, because a hand-written flow may need one as a genuine last
 * resort and the honest floor is that a page with no semantic markup leaves
 * nothing better. This is what a *recorder* consults — discovery has the whole
 * page to choose from, so a target that counts to an element there is a choice
 * rather than a floor, and it is the choice that goes stale on the day a row is
 * added above the one that was meant.
 */
export function incidentalSelector(selector: string): string | undefined {
  if (POSITIONAL.test(selector)) {
    return 'a positional path: it counts to the element rather than naming it, and any re-render can move it';
  }

  // An attribute value may legitimately contain a dot — `[href="a.b"]` — and it
  // is not a class token.
  const bare = selector.replace(/"[^"]*"|'[^']*'/g, '""');

  for (const match of bare.matchAll(CLASS_TOKEN)) {
    const token = match[1] ?? '';
    if (looksGenerated(token)) {
      return `a generated class name (${token}): it is a build artifact and does not survive a rebuild`;
    }
  }

  return undefined;
}

/**
 * Whether a chain is ordered best-first.
 *
 * Discovery records every strategy that resolves uniquely, ordered by
 * preference. A chain that is not ordered would make the fallback signal
 * meaningless: "a weaker strategy carried it" only reads as drift if the
 * stronger one was genuinely tried first.
 */
export function isBestFirst(chain: TargetChain): boolean {
  let previous = -1;

  for (const target of chain) {
    const rank = strategyRank(target);
    if (rank < previous) {
      return false;
    }
    previous = rank;
  }

  return true;
}

/** The accessible names a target admits, as a list. */
export function namesOf(target: Target): readonly string[] {
  switch (target.by) {
    case 'role':
      return target.name === undefined ? [] : normalize(target.name);
    case 'label':
      return normalize(target.text);
    case 'text':
      return [target.text];
    case 'css':
      return [];
  }
}

function normalize(name: AccessibleName): readonly string[] {
  return typeof name === 'string' ? [name] : name;
}

/** A stable, human-readable rendering, for run-record entries and error messages. */
export function describeTarget(target: Target): string {
  switch (target.by) {
    case 'role':
      return target.name === undefined
        ? `role=${target.role}`
        : `role=${target.role} name=${renderName(target.name)}`;
    case 'label':
      return `label=${renderName(target.text)}`;
    case 'text':
      return `text=${JSON.stringify(target.text)}`;
    case 'css':
      return `css=${JSON.stringify(target.selector)}`;
  }
}

function renderName(name: AccessibleName): string {
  return typeof name === 'string'
    ? JSON.stringify(name)
    : `[${name.map((alternative) => JSON.stringify(alternative)).join(' | ')}]`;
}
