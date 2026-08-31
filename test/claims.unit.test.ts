import { describe, expect, it } from 'vitest';

import { CLAIMS, coverage, danglingReferences } from './claims.js';

/**
 * The claim registry's own guard.
 *
 * It deliberately does **not** fail on an uncovered claim. Most of the design is
 * not built yet, and a gate that went red for unwritten phases would be turned
 * off within a week. What it does enforce is that the registry stays honest: no
 * duplicate ids, no test pointing at a claim that no longer exists, and no claim
 * pointing at a phase the plan does not have.
 *
 * The count itself is a report, not a threshold — `npm run claims`.
 */
describe('the claim registry', () => {
  it('gives every claim a unique id', () => {
    const ids = CLAIMS.map((claim) => claim.id);

    expect(new Set(ids).size, 'duplicate claim ids').toBe(ids.length);
  });

  it('leaves no test pointing at a claim that does not exist', () => {
    // The failure this catches: a claim is renamed or dropped, and a `@covers`
    // comment goes on quietly asserting coverage of nothing.
    expect(danglingReferences()).toEqual([]);
  });

  it('assigns every claim to a phase the plan actually has', () => {
    const outOfRange = CLAIMS.filter((claim) => claim.phase < 0 || claim.phase > 10);

    expect(outOfRange.map((claim) => claim.id)).toEqual([]);
  });

  it('cites a section of the design document for every claim', () => {
    const unsourced = CLAIMS.filter((claim) => claim.section.trim() === '');

    expect(unsourced.map((claim) => claim.id)).toEqual([]);
  });

  it('finds the coverage markers at all', () => {
    // Guards the guard: a broken scanner would report every claim uncovered and
    // read as a catastrophe rather than as a bug in the scanner.
    expect(coverage().filter((row) => row.coveredBy.length > 0).length).toBeGreaterThan(0);
  });
});
