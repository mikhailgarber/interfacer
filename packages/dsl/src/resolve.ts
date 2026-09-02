/**
 * Turning a {@link Target} into a live element.
 *
 * A target is an ordered chain of strategies, recorded best-first, and this is
 * where the order earns its keep: the first strategy that resolves uniquely
 * wins, and *which* one won is recorded. A fallback winning is the drift signal
 * — the primary strategy failing while a weaker one succeeds means the
 * application changed in a way the artifact survived by luck, and it is reported
 * with the run rather than passing silently.
 */
import type { Locator, Page } from 'playwright';

import { namesOf, type Strategy, type Target, type TargetChain } from './target.js';

/**
 * How many matches a step will accept.
 *
 * Acting on an element and asking whether a condition is present are different
 * questions, and conflating them gets one of them wrong.
 *
 * - `unique` — acting, reading, or asserting a specific element. Two elements
 *   answering to the same description means the recorded intent is no longer
 *   unambiguous, and acting on either is a guess. Never "take the first".
 * - `present` — an outcome detector, which is a predicate rather than a target.
 *   "Is 'No such account' on this page" has the same answer whether the phrase
 *   appears once or in both a heading and a banner.
 */
export type Arity = 'unique' | 'present';

export type Resolution =
  | {
      readonly found: true;
      readonly locator: Locator;
      readonly strategy: Strategy;
      /** Position in the chain. Anything above zero is drift. */
      readonly index: number;
      readonly matches: number;
    }
  | { readonly found: false; readonly reason: 'no-match' }
  | {
      readonly found: false;
      readonly reason: 'ambiguous';
      readonly strategy: Strategy;
      readonly index: number;
      readonly matches: number;
    };

/**
 * Build a locator for one strategy.
 *
 * Alternatives are OR-ed rather than tried in turn, because they are one
 * accessible name spelled two ways — not two strategies. "Member ID" and
 * "Customer ID" naming the same field is a tenant difference the design absorbs
 * here; anything more than a name would be an override layer wearing a
 * different hat.
 */
function locatorFor(page: Page, target: Target): Locator {
  switch (target.by) {
    case 'role': {
      const names = namesOf(target);
      if (names.length === 0) {
        return page.getByRole(target.role as Parameters<Page['getByRole']>[0]);
      }
      return names
        .map((name) =>
          page.getByRole(target.role as Parameters<Page['getByRole']>[0], { name, exact: true }),
        )
        .reduce((left, right) => left.or(right));
    }

    case 'label':
      return namesOf(target)
        .map((text) => page.getByLabel(text, { exact: true }))
        .reduce((left, right) => left.or(right));

    case 'text':
      // Substring, not exact. `text` identifies a control by what it says, and
      // an outcome banner reads "No such account: ACC-9999" while the condition
      // recorded is "No such account".
      return page.getByText(target.text);

    case 'css':
      return page.locator(target.selector);
  }
}

/**
 * Walk the chain and return the first strategy that satisfies the arity.
 *
 * A strategy matching zero elements is a miss, and the chain continues past it.
 * A strategy matching several under `unique` arity is **not** a miss: it is a
 * hard failure on the spot, because falling through would quietly resolve a
 * target whose recorded meaning has become unclear.
 */
const POLL_INTERVAL_MS = 50;

/** One pass down the chain, with no waiting. */
async function sweep(
  page: Page,
  chain: TargetChain,
  arity: Arity,
): Promise<Resolution | undefined> {
  // An ambiguous strategy is remembered rather than returned: "never take the
  // first" is a rule about the *matches*, not about the chain. Choosing between
  // two elements is a guess; falling through to a strategy that identifies one
  // of them is the fallback doing its job. Reported only if nothing else in the
  // chain resolves uniquely, so the reason a step failed is still the real one.
  let ambiguous: Resolution | undefined;

  for (const [index, target] of chain.entries()) {
    const locator = locatorFor(page, target);
    const matches = await locator.count();

    if (matches === 0) {
      continue;
    }

    if (matches > 1 && arity === 'unique') {
      ambiguous ??= { found: false, reason: 'ambiguous', strategy: target.by, index, matches };
      continue;
    }

    return {
      found: true,
      locator: arity === 'present' ? locator.first() : locator,
      strategy: target.by,
      index,
      matches,
    };
  }

  return ambiguous;
}

export async function resolveTarget(
  page: Page,
  chain: TargetChain,
  arity: Arity,
  timeoutMs: number,
): Promise<Resolution> {
  const deadline = Date.now() + timeoutMs;

  // Polled rather than waited on. Waiting out the full budget on the primary
  // strategy before even looking at the rest would make every step on an
  // application without semantic markup pay the timeout, and would say nothing
  // extra: sweeping the whole chain each poll still prefers the strongest
  // strategy present, and returns the moment anything is.
  for (;;) {
    const resolution = await sweep(page, chain, arity);
    if (resolution !== undefined) {
      return resolution;
    }

    if (Date.now() >= deadline) {
      return { found: false, reason: 'no-match' };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Whether a resolution means the application has moved from what was recorded. */
export function isDrift(resolution: Resolution): boolean {
  return resolution.found && resolution.index > 0;
}
