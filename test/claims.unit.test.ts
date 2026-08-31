import { describe, expect, it } from 'vitest';

import { claims, coverage, danglingReferences, parseClaims } from './claims.js';

/**
 * The claim registry's own guard.
 *
 * The registry is the design document. Claims are not restated here — they are
 * markers in the prose, and everything else about a claim is derived: its
 * section is the heading it sits under, its order is the document's. Neither can
 * drift from the design, because neither is a field any more.
 *
 * It deliberately does **not** fail on an uncovered claim. Most of the design is
 * not built yet, and a gate that went red for unwritten phases would be turned
 * off within a week. The count is a report, not a threshold — `npm run claims`.
 *
 * What it does enforce is that the join stays honest at both ends.
 */
describe('the claim registry', () => {
  it('parses the design document', () => {
    // Guards the guard. A broken marker regex finds nothing, every claim reports
    // uncovered, and the report reads as a catastrophe rather than as a bug in
    // the reader — or worse, reads as 0/0 and passes.
    expect(claims().length).toBeGreaterThan(50);
  });

  it('leaves no test pointing at a claim that does not exist', () => {
    // The failure this catches: a claim is renamed or its marker removed, and a
    // `@covers` comment goes on quietly asserting coverage of nothing.
    expect(danglingReferences()).toEqual([]);
  });

  it('finds the coverage markers at all', () => {
    expect(coverage().filter((row) => row.coveredBy.length > 0).length).toBeGreaterThan(0);
  });

  it('sources every claim from a heading and a phase', () => {
    // Both are derived, so this is a check on the parser rather than on the
    // author: a claim with no section means the marker was placed above the
    // document's first heading.
    const unsourced = claims().filter(
      (claim) => claim.section.trim() === '' || claim.claim.trim() === '',
    );

    expect(unsourced.map((claim) => claim.id)).toEqual([]);
  });
});

/**
 * The parser refuses what it cannot read.
 *
 * A marker that does not parse is the failure whose evidence is an absence: it
 * would silently delete a claim from the report, and the run would look clean.
 * These assert against the parser directly rather than by mutating the design
 * document, which no test should be writing to.
 */
describe('a marker the parser cannot read', () => {
  it.each([
    ['no phase', '<sup>[c](x "claim: some.claim")</sup>'],
    ['a misspelled phase', '<sup>[c](x "claim: some.claim phase 3")</sup>'],
    ['no id', '<sup>[c](x "claim: — phase 3")</sup>'],
    ['a title that is not a claim at all', '<sup>[c](x "see below")</sup>'],
  ])('a marker with %s is an error, not a claim quietly dropped', (_label, marker) => {
    expect(() => parseClaims(['# heading', `A statement. ${marker}`])).toThrow(/claim marker/);
  });

  it('refuses two markers naming the same claim', () => {
    expect(() =>
      parseClaims([
        '# heading',
        'One. <sup>[c](x "claim: same.id — phase 3")</sup>',
        'Two. <sup>[c](x "claim: same.id — phase 3")</sup>',
      ]),
    ).toThrow(/already declared/);
  });

  it('refuses a phase the plan does not have', () => {
    expect(() =>
      parseClaims(['# heading', 'One. <sup>[c](x "claim: some.id — phase 44")</sup>']),
    ).toThrow(/which the plan does not have/);
  });

  it('refuses a claim that sits above the first heading', () => {
    expect(() => parseClaims(['One. <sup>[c](x "claim: some.id — phase 3")</sup>'])).toThrow(
      /under no heading/,
    );
  });
});
