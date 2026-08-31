import { describe, expect, it } from 'vitest';

import { packageName } from '@interfacer/fixtures';

/**
 * Phase 0 scaffold. Phase 2 replaces this with the fixtures tier proper: every
 * route and every exceptional trigger on all five apps, served over real HTTP
 * and asserted at the HTTP level, with no engine and no browser involved.
 */
describe('@interfacer/fixtures scaffold', () => {
  it('resolves as a workspace package', () => {
    expect(packageName).toBe('@interfacer/fixtures');
  });
});
