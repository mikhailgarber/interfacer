import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TEST_ROOTS, TIERS, testRootPattern, type Tier } from './tiers.js';

/**
 * The suite's guard against its own blind spot.
 *
 * A tier is a filename suffix, and a suffix is a convention — nothing in the
 * runner objects to a test file that matches no tier. Such a file is never
 * collected, so a failing assertion inside it reports as a clean run. That is
 * the one failure mode a test suite cannot catch by testing harder, because the
 * evidence of it is an absence.
 *
 * So this checks the shape of the suite itself: every test file belongs to
 * exactly one tier, sits under a known root, and every tier has something to
 * run.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.playwright', 'coverage']);

/** A file the runner collects and executes. Disjoint from {@link isTypeTest}. */
const isRuntimeTest = (path: string): boolean => path.endsWith('.test.ts');

/** A file `tsc` checks and never executes. */
const isTypeTest = (path: string): boolean => path.endsWith('.test-d.ts');

/** Every test file in the repo, as a repo-relative posix path. */
function discoverTestFiles(): string[] {
  return readdirSync(REPO_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      `${entry.parentPath}/${entry.name}`.slice(REPO_ROOT.length).replaceAll('\\', '/'),
    )
    .filter((path) => !path.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment)))
    .filter((path) => isRuntimeTest(path) || isTypeTest(path))
    .sort();
}

/** The tiers a runtime test file's name claims. Exactly one is the rule. */
function claimedTiers(path: string): Tier[] {
  return TIERS.filter((tier) => path.endsWith(`.${tier}.test.ts`));
}

describe('the suite itself', () => {
  const testFiles = discoverTestFiles();

  it('found test files to check', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it('keeps every test file under a known root', () => {
    const rootPattern = testRootPattern();
    const misplaced = testFiles.filter((path) => !rootPattern.test(path));

    expect(misplaced, `not under any of ${TEST_ROOTS.join(', ')}`).toEqual([]);
  });

  it('gives every runtime test file exactly one tier', () => {
    const runtimeTests = testFiles.filter(isRuntimeTest);

    const orphaned = runtimeTests.filter((path) => claimedTiers(path).length === 0);
    const ambiguous = runtimeTests.filter((path) => claimedTiers(path).length > 1);

    // An orphan is the dangerous case: it is never collected, so whatever it
    // asserts is never checked and the run still reports green.
    expect(orphaned, `no tier suffix, so never collected — expected one of ${TIERS.join(', ')}`) //
      .toEqual([]);
    expect(ambiguous, 'matches more than one tier').toEqual([]);
  });

  it('leaves no tier matching zero files', () => {
    // A tier whose glob matches nothing passes, loudly and meaninglessly.
    const empty = TIERS.filter(
      (tier) => !testFiles.some((path) => path.endsWith(`.${tier}.test.ts`)),
    );

    expect(empty, 'these tiers would pass by running nothing').toEqual([]);
  });
});
