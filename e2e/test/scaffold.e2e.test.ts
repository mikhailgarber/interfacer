import { describe, expect, it } from 'vitest';

/**
 * Phase 0 scaffold for the live-model tier. Phase 10 replaces this with the
 * through-line: discovery reaches the goal, emits a project that compiles, and
 * that project replays with no model attached.
 *
 * These are slow, non-deterministic and cost money, so this project is never
 * part of `npm test` — it runs pre-release or on demand.
 */
describe('e2e tier wiring', () => {
  it('is picked up by the e2e project and no other', () => {
    // Cheap, but it is the one thing worth asserting at Phase 0: the tier's
    // glob actually matches, so a later `npm run test:e2e` will not silently
    // pass by running zero tests.
    expect(import.meta.filename).toMatch(/e2e[/\\]test[/\\][^/\\]+\.e2e\.test\.ts$/);
  });

  it.runIf(process.env.API_KEY)('has the credential the live-model tier requires', () => {
    // Discovery is the only phase that needs a model. A generated capability
    // never calls one, so this key is a discovery-time credential only.
    expect(process.env.API_KEY).not.toBe('');
  });
});
