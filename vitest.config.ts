import { defineConfig } from 'vitest/config';

import { includeGlobs, typecheckGlobs } from './test/tiers.js';

/**
 * One runner, four tiers.
 *
 * A test's tier is its filename suffix, not its directory, because the tiers cut
 * across packages: `@interfacer/dsl` has unit and integration tests, `interfacer`
 * has unit and agent-loop tests, and both are proved against the same fixtures.
 * The tier list and the roots live in `test/tiers.ts`, which `test/suite.unit.test.ts`
 * also reads to prove no test file falls outside them.
 *
 * | project       | browser | app     | model    | invoked by  |
 * | ------------- | ------- | ------- | -------- | ----------- |
 * | `unit`        | no      | no      | no       | `npm test`  |
 * | `fixtures`    | no      | HTTP    | no       | `npm test`  |
 * | `integration` | yes     | fixture | no       | `npm test`  |
 * | `agent`       | yes     | fixture | scripted | `npm test`  |
 *
 * `npm test` runs all four — every tier gates. What would keep a tier out of the
 * gate is a live model in the loop, not a browser or a fixture: a scripted
 * `decide` is deterministic and free, so the agent tier gates like any other.
 * There is no live-model tier; that validation is done by hand — see
 * `docs/testing.md`, "live-model validation".
 *
 * What this file does *not* describe is written down in `docs/testing.md`:
 * tests import from `dist`, so a build has to precede them, and the fixture
 * lifecycle, port allocation and stdout capture are decisions Phases 2 and 3
 * still have to make.
 */
export default defineConfig({
  test: {
    coverage: {
      // v8 rather than istanbul: no instrumentation pass, so the integration
      // tier is not slowed further. It measures the Node process, which is where
      // the engine runs — the browser is the thing being driven, not the thing
      // under test.
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',

      // Coverage is collected from `dist/` and reported against `src/`.
      //
      // That looks wrong and is not: tests import each package through its
      // `exports` map, the same path a generated capability takes, so `dist/` is
      // what actually executes. Pointing `include` at `src/` finds the files and
      // attributes nothing to them. Naming the emitted JavaScript is what makes
      // the provider read the emitted source maps, which is what puts the counts
      // back on the TypeScript they came from — so the report reads in `.ts`
      // even though the run did not.
      //
      // A consequence: `npm run build` has to precede coverage, and a stale
      // build measures stale code.
      include: ['packages/*/dist/**/*.js', 'fixtures/dist/**/*.js'],

      exclude: [
        // Exercised by `serve.fixtures.test.ts`, which spawns it as a child
        // process — and v8 coverage in this process cannot see another one. It
        // is tested; it is only unmeasurable from here.
        '**/dist/serve.js',
        // A not-implemented stub until Phase 9.
        '**/dist/cli.js',
      ],
    },

    // The workspace packages resolve through `node_modules` symlinks, so Vite
    // treats them as external dependencies and hands them straight to Node —
    // where the coverage provider never sees them. Inlining makes Vite process
    // them, which is what lets v8's counts be mapped back through the emitted
    // source maps onto the TypeScript they came from.
    server: {
      deps: {
        inline: [/@interfacer\//, /^interfacer$/],
      },
    },

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
    ],
  },
});
