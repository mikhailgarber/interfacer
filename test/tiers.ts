/**
 * The test tiers, declared once.
 *
 * `vitest.config.ts` reads this to build its projects, and `suite.unit.test.ts`
 * reads it to prove that every test file in the repo actually belongs to one of
 * them. Two consumers, one declaration — a second copy of this list would be
 * free to drift, and the thing it would drift into is a tier that silently runs
 * nothing.
 */

/** Ordered cheapest-first, which is also the order they are worth running in. */
export const TIERS = ['unit', 'fixtures', 'integration', 'agent', 'e2e'] as const;

export type Tier = (typeof TIERS)[number];

/**
 * Where test files may live. `*` stands for a single path segment.
 *
 * Tier and location are deliberately independent: a tier is the filename suffix,
 * and any root may hold any tier. The tiers cut across packages — `@interfacer/dsl`
 * has unit and integration tests, `interfacer` has unit and agent-loop tests — so
 * tying a tier to a directory would fight the layout and, worse, would silently
 * drop a correctly-named test filed in the "wrong" place.
 */
export const TEST_ROOTS = ['test', 'packages/*/test', 'fixtures/test', 'e2e/test'] as const;

/** Runtime test files for one tier, as globs relative to the repo root. */
export function includeGlobs(tier: Tier): string[] {
  return TEST_ROOTS.map((root) => `${root}/**/*.${tier}.test.ts`);
}

/**
 * Type-level test files. These are claims about types — `fields()`, `Infer`,
 * `AnswerOf` — so the compiler is the only thing that can check them. They run
 * in the `unit` tier.
 */
export function typecheckGlobs(): string[] {
  return TEST_ROOTS.map((root) => `${root}/**/*.test-d.ts`);
}

/** Matches any path that sits under one of {@link TEST_ROOTS}. */
export function testRootPattern(): RegExp {
  const alternatives = TEST_ROOTS.map((root) =>
    root
      .split('/')
      .map((segment) => (segment === '*' ? '[^/]+' : segment))
      .join('/'),
  ).join('|');
  return new RegExp(`^(${alternatives})/`);
}
