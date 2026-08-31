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
