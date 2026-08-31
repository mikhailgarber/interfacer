/**
 * Design-claim coverage.
 *
 * The design document is the source of truth. A statement that a test could
 * falsify carries a marker naming the claim and the plan phase that should
 * verify it; this reads the document, joins the markers to the `@covers`
 * comments in the suite, and reports the two together.
 *
 * Nothing is restated here. `section` is the nearest enclosing heading and the
 * ordering is the document's, so neither can drift — they are not fields any
 * more.
 *
 * Line coverage says whether code ran. It cannot say whether the suite verifies
 * what the design claims — a module can sit at 100% and prove nothing.
 *
 * What this still cannot check is whether a statement that deserves a marker has
 * one. That judgement is a human reading the design; what it *can* check is that
 * every marker parses, that no two name the same claim, and that no `@covers`
 * points at a claim that no longer exists.
 *
 * Run directly: `node test/claims.ts`
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DESIGN = 'docs/design-requirements.md';

export interface Claim {
  readonly id: string;
  /** The nearest enclosing heading. Derived, not declared. */
  readonly section: string;
  /** The statement the marker terminates, back to the line start or the previous marker. */
  readonly claim: string;
  /** The implementation-plan phase that should verify it. */
  readonly phase: number;
  /** Line in the design document, so the report is clickable. */
  readonly line: number;
}

/**
 * A claim marker, placed inline at the end of the statement it marks:
 *
 * ```md
 * …whenever the flow is edited.<sup>[c](testing.md#design-claim-coverage "claim: artifact.stable-step-ids — phase 3")</sup>
 * ```
 *
 * It renders as a small superscript `c` — a citation, which is what it is: the
 * design citing the test that holds it to its word. A reader who hovers gets the
 * id and the phase, and one who clicks lands on the explanation. That visibility
 * is the whole reason it is a link rather than an HTML comment; a marker nobody
 * reading the rendered document knows about is one nobody maintains.
 *
 * Never on its own line, which would terminate a list, and never able to sit
 * inside a table cell. The id and phase live in the link title, so this is the
 * one and only place either is written down.
 */
const MARKER_SOURCE = String.raw`<sup>\[c\]\(\S+ "claim: (\S+) — phase (\d+)"\)</sup>`;
/** A fresh instance per use: a shared global regex carries `lastIndex` between callers. */
const marker = (): RegExp => new RegExp(MARKER_SOURCE, 'g');
/**
 * Anything that opens like a marker, checked after the valid ones are removed.
 *
 * This is the guard that matters. A marker whose title is misspelled still
 * renders as a perfectly ordinary superscript, so nothing about the document
 * would look wrong — the claim would simply vanish from the report and the run
 * would read as clean.
 */
const MALFORMED = /<sup>\[c\]\(|"claim:/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/** Strip list bullets, numbering, table pipes and emphasis noise from a claim. */
function tidy(text: string): string {
  return text
    .replace(marker(), ' ')
    .replace(/^[|>]\s*/, '')
    .replace(/^[*-]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ClaimSyntaxError extends Error {}

/**
 * Parse markers out of the document's lines.
 *
 * Separate from {@link claims} so the guards below can be exercised on a few
 * lines rather than by writing to the design document, which no test should be
 * doing.
 */
export function parseClaims(source: readonly string[]): readonly Claim[] {
  const found: Claim[] = [];
  const seen = new Map<string, number>();
  let section = '';

  source.forEach((text, index) => {
    const line = index + 1;

    const heading = HEADING.exec(text);
    if (heading !== null) {
      section = (heading[2] ?? '').trim();
      return;
    }

    if (MALFORMED.test(text.replace(marker(), ''))) {
      // The failure whose evidence is an absence: a typo'd marker would
      // otherwise drop a claim from the report and read as a clean run.
      throw new ClaimSyntaxError(`${DESIGN}:${String(line)}: unparseable claim marker`);
    }

    const scan = marker();
    let match: RegExpExecArray | null;
    let from = 0;

    while ((match = scan.exec(text)) !== null) {
      const id = match[1] ?? '';
      const phase = Number(match[2]);

      if (section === '') {
        throw new ClaimSyntaxError(`${DESIGN}:${String(line)}: claim ${id} sits under no heading`);
      }
      const first = seen.get(id);
      if (first !== undefined) {
        throw new ClaimSyntaxError(
          `${DESIGN}:${String(line)}: claim ${id} already declared at line ${String(first)}`,
        );
      }
      if (phase < 0 || phase > 10) {
        throw new ClaimSyntaxError(
          `${DESIGN}:${String(line)}: claim ${id} names phase ${String(phase)}, which the plan does not have`,
        );
      }

      seen.set(id, line);
      found.push({ id, section, claim: tidy(text.slice(from, match.index)), phase, line });
      from = match.index + match[0].length;
    }
  });

  return found;
}

let cached: readonly Claim[] | undefined;

/** The claims the design document declares, in document order. */
export function claims(): readonly Claim[] {
  cached ??= parseClaims(readFileSync(`${REPO_ROOT}${DESIGN}`, 'utf8').split('\n'));
  return cached;
}

// ---- the join with the suite (unchanged from today) -----------------------

const IGNORED = new Set(['node_modules', 'dist', '.git', 'coverage', '.playwright']);
const COVERS = /@covers[ \t]+([^\n]+)/g;

function testFiles(): string[] {
  return readdirSync(REPO_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      `${entry.parentPath}/${entry.name}`.slice(REPO_ROOT.length).replaceAll('\\', '/'),
    )
    .filter((path) => !path.split('/').some((segment) => IGNORED.has(segment)))
    .filter((path) => path.endsWith('.test.ts') || path.endsWith('.test-d.ts'))
    .sort();
}

export function declaredCoverage(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const path of testFiles()) {
    const source = readFileSync(`${REPO_ROOT}${path}`, 'utf8');
    COVERS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COVERS.exec(source)) !== null) {
      for (const id of (match[1] ?? '').split(/[\s,]+/).filter(Boolean)) {
        byId.set(id, [...(byId.get(id) ?? []), path]);
      }
    }
  }
  return byId;
}

export interface Coverage {
  readonly claim: Claim;
  /** Repo-relative paths of the test files that declare they exercise it. */
  readonly coveredBy: readonly string[];
}

export function coverage(): Coverage[] {
  const declared = declaredCoverage();
  return claims().map((claim) => ({ claim, coveredBy: declared.get(claim.id) ?? [] }));
}

export function danglingReferences(): string[] {
  const known = new Set(claims().map((claim) => claim.id));
  return [...declaredCoverage().keys()].filter((id) => !known.has(id)).sort();
}

function report(): string {
  const rows = coverage();
  const lines: string[] = ['', 'Design-claim coverage', ''];

  let section = '';
  for (const { claim, coveredBy } of rows) {
    if (claim.section !== section) {
      section = claim.section;
      lines.push(`  ${section}`);
    }
    lines.push(
      `    ${coveredBy.length > 0 ? '✓' : '·'} ${claim.id.padEnd(40)} phase ${String(claim.phase).padEnd(2)}  ${DESIGN}:${String(claim.line)}`,
    );
    if (coveredBy.length > 0) {
      lines.push(`        ${coveredBy.join(', ')}`);
    }
  }

  const byPhase = new Map<number, { covered: number; total: number }>();
  for (const { claim, coveredBy } of rows) {
    const tally = byPhase.get(claim.phase) ?? { covered: 0, total: 0 };
    byPhase.set(claim.phase, {
      covered: tally.covered + (coveredBy.length > 0 ? 1 : 0),
      total: tally.total + 1,
    });
  }

  lines.push('', '  by phase', '');
  for (const [phase, tally] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(
      `    phase ${String(phase).padEnd(3)} ${String(tally.covered).padStart(2)}/${String(tally.total).padEnd(2)}${tally.covered === tally.total ? '' : '   <- incomplete'}`,
    );
  }

  const covered = rows.filter((row) => row.coveredBy.length > 0).length;
  lines.push('', `  ${String(covered)}/${String(rows.length)} claims covered.`, '');

  lines.push(
    '  A claim from a later phase is pending, not a gap. An uncovered claim from a',
    '  phase already delivered is the number worth looking at.',
    '',
  );

  // Never elided. A `@covers` naming a claim no marker declares is a broken
  // join, not a statistic — and the test tier fails on it either way.
  const dangling = danglingReferences();
  if (dangling.length > 0) {
    lines.push(
      `  ${String(dangling.length)} @covers reference ids that no marker declares:`,
      ...dangling.map((id) => `    ${id}`),
      '',
    );
  }

  return lines.join('\n');
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  process.stdout.write(report());
}
