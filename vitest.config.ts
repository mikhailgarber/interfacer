import { defineConfig } from 'vitest/config';

import { includeGlobs, typecheckGlobs } from './test/tiers.js';

/**
 * One runner, five tiers.
 *
 * A test's tier is its filename suffix, not its directory, because the tiers cut
 * across packages: `@interfacer/dsl` has unit and integration tests, `interfacer`
 * has unit and agent-loop tests, and both are proved against the same fixtures.
 * The tier list and the roots live in `test/tiers.ts`, which `test/suite.unit.test.ts`
 * also reads to prove no test file falls outside them.
 *
 * | project       | browser | app     | model    | invoked by           |
 * | ------------- | ------- | ------- | -------- | -------------------- |
 * | `unit`        | no      | no      | no       | `npm test`           |
 * | `fixtures`    | no      | HTTP    | no       | `npm test`           |
 * | `integration` | yes     | fixture | no       | `npm test`           |
 * | `agent`       | yes     | fixture | scripted | `npm run test:agent` |
 * | `e2e`         | yes     | fixture | live     | `npm run test:e2e`   |
 *
 * `npm test` runs the first three — the ones that are fast, deterministic and
 * free. The last two cost wall-clock or money, so they are invoked explicitly
 * rather than swept into the default gate.
 *
 * What this file does *not* describe is written down in `docs/testing.md`:
 * tests import from `dist`, so a build has to precede them, and the fixture
 * lifecycle, port allocation and stdout capture are decisions Phases 2 and 3
 * still have to make.
 */
export default defineConfig({
  test: {
    // Pinned, not defaulted. Phase 3 asserts that replaying one flow N times
    // produces the same steps, the same resolutions and the same result — a
    // retry here would mask exactly the nondeterminism that test exists to
    // catch. Raising this is a design decision, not a flake remedy.
    retry: 0,

    projects: [
      {
        test: {
          name: 'unit',
          include: includeGlobs('unit'),
          typecheck: {
            enabled: true,
            include: typecheckGlobs(),
          },
        },
      },
      {
        test: {
          name: 'fixtures',
          include: includeGlobs('fixtures'),
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: includeGlobs('integration'),
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'agent',
          include: includeGlobs('agent'),
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: includeGlobs('e2e'),
          testTimeout: 900_000,
          hookTimeout: 900_000,
        },
      },
    ],
  },
});
