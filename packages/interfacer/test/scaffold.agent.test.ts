import { describe, expect, it } from 'vitest';

import { packageName, targetStrategyPreference } from 'interfacer';

/**
 * Phase 0 scaffold for the agent-loop tier. Phase 8 replaces this with tests
 * that drive a real browser against a real fixture through a scripted
 * `decide(state, tools)` — step appending, cost accounting, stall detection,
 * budget exhaustion, and the between-turns allowlist check.
 */
describe('interfacer scaffold', () => {
  it('resolves as a workspace package', () => {
    expect(packageName).toBe('interfacer');
  });

  it('consumes @interfacer/dsl as an ordinary consumer', () => {
    // The design's dependency graph runs one way: Interfacer consumes the DSL
    // package on the same terms as the projects it writes. `tsc --build` proves
    // the edge at compile time; this proves it resolves at run time too.
    expect(targetStrategyPreference).toEqual(['role', 'label', 'text', 'css']);
  });
});
