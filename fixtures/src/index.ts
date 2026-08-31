/**
 * The fixture applications.
 *
 * Phase 2 builds five real HTTP apps here — `clean`, `legacy`, `hostile`,
 * `rebranded` and `skewed` — each serving a login, a search, a detail screen and
 * a multi-field action with a confirmation step, each able to produce every
 * exceptional condition on demand, with fixed data and no dependence on the
 * clock.
 *
 * They are servers rather than stubbed page objects because the rules the engine
 * implements — navigation, resolved URLs after redirect, session expiry,
 * multi-page flow — do not exist without one.
 *
 * `packageName` exists only so the scaffold's smoke test can prove this
 * workspace resolves. It is deleted in Phase 2.
 */
export const packageName = '@interfacer/fixtures';
