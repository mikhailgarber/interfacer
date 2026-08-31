/**
 * Design-claim coverage.
 *
 * Line coverage answers "was this code executed". It cannot answer the question
 * that matters here, which is "does the suite verify what the design says". A
 * module can be at 100% and prove nothing, and the properties this design turns
 * on — a business outcome is returned rather than thrown, a fallback resolution
 * is reported as drift, a secret never reaches the record — are claims about
 * behaviour, not about lines.
 *
 * So the claims are enumerated here, tests declare which ones they exercise with
 * a `@covers <id>` comment, and `npm run claims` reports the join.
 *
 * Two things keep this from becoming a document that rots:
 *
 * - `claims.unit.test.ts` fails on a `@covers` naming an id that does not exist,
 *   so a renamed or deleted claim cannot leave a dangling reference.
 * - Every claim carries the phase that should verify it, so an uncovered claim
 *   from a phase that has not happened is visibly *pending* rather than
 *   indistinguishable from a gap.
 *
 * What this cannot check is its own completeness. The registry is written by
 * hand from `docs/design-requirements.md`, and a claim nobody wrote down is a
 * claim nobody will notice is untested. Read it against the design when the
 * design changes.
 *
 * Run directly: `node test/claims.ts`
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Claim {
  readonly id: string;
  /** The heading in `docs/design-requirements.md` this comes from. */
  readonly section: string;
  /** The claim, in the design's own words wherever they are short enough. */
  readonly claim: string;
  /** The implementation-plan phase that should verify it. */
  readonly phase: number;
}

/** Ordered as the design document orders them. */
export const CLAIMS: readonly Claim[] = [
  // ---- positions ----------------------------------------------------------
  {
    id: 'position.artifact-is-a-program',
    section: 'positions',
    claim:
      'Steps are a small TypeScript DSL, so the recorded flow reads as a description of itself.',
    phase: 3,
  },
  {
    id: 'position.contract-in-types',
    section: 'positions',
    claim: 'The contract is expressed in types; every other representation is projected from it.',
    phase: 1,
  },
  {
    id: 'position.outcomes-are-contract',
    section: 'positions',
    claim: '"No such account" is an answer, not a crash; only genuine breakage is thrown.',
    phase: 3,
  },
  {
    id: 'position.guardrails-human-authored',
    section: 'positions',
    claim: 'Interfacer proposes guardrails; the user confirms them.',
    phase: 9,
  },

  // ---- scope --------------------------------------------------------------
  {
    id: 'scope.target-names-own-strategy',
    section: 'scope',
    claim:
      'An element target is a structured value that names its own strategy, never an opaque selector string.',
    phase: 1,
  },

  // ---- durable artifact ---------------------------------------------------
  {
    id: 'artifact.no-serialized-form',
    section: 'durable artifact',
    claim:
      'Nothing is serialized out of the flow object: no manifest, no step file, no exported description.',
    phase: 3,
  },
  {
    id: 'artifact.closed-vocabulary',
    section: 'durable artifact',
    claim: 'A capability can do nothing the DSL does not name; the bound is structural.',
    phase: 3,
  },
  {
    id: 'artifact.stable-step-ids',
    section: 'durable artifact',
    claim:
      'Every DSL call carries a stable step id, so errors refer to `login.submit` rather than a position that shifts.',
    phase: 3,
  },
  {
    id: 'artifact.version-is-the-project',
    section: 'durable artifact',
    claim:
      "A capability's version is the `package.json` version; the flow declares none of its own.",
    phase: 7,
  },

  // ---- components ---------------------------------------------------------
  {
    id: 'components.one-way-dependencies',
    section: 'components',
    claim: 'The DSL library knows nothing about Interfacer, the agent loop, or any model.',
    phase: 0,
  },
  {
    id: 'components.no-sdk-at-replay',
    section: 'components',
    claim: 'A capability in production never loads an SDK and never needs an API key.',
    phase: 7,
  },
  {
    id: 'components.one-engine-two-callers',
    section: 'components',
    claim: 'Discovery and replay are the same engine; only what decides the next step differs.',
    phase: 8,
  },

  // ---- the DSL ------------------------------------------------------------
  {
    id: 'dsl.parameterized-by-construction',
    section: 'the DSL',
    claim:
      'Verbs take values as accessors on the input rather than as literals, so a flow is parameterized by construction.',
    phase: 3,
  },
  {
    id: 'dsl.commit-never-retried',
    section: 'the DSL',
    claim: '`.commit()` is never retried, since a timed-out commit may already have gone through.',
    phase: 3,
  },
  {
    id: 'dsl.no-general-branching',
    section: 'the DSL',
    claim: 'A flow is a statically enumerable step list; there is no branching on page state.',
    phase: 3,
  },
  {
    id: 'dsl.outcome-terminates',
    section: 'the DSL',
    claim: 'The engine terminates on a matched outcome; nothing after it executes.',
    phase: 3,
  },
  {
    id: 'dsl.optional-is-a-noop',
    section: 'the DSL',
    claim:
      '`.optional()` runs a step only if the target resolves, and is a no-op when it does not.',
    phase: 3,
  },
  {
    id: 'dsl.oneof-arms-enumerable',
    section: 'the DSL',
    claim: '`.oneOf()` takes one of a small set of expected screens, each arm naming its detector.',
    phase: 3,
  },

  // ---- targeting ----------------------------------------------------------
  {
    id: 'target.chain-recorded-best-first',
    section: 'targeting',
    claim: 'A target is an ordered chain of strategies, recorded best-first.',
    phase: 1,
  },
  {
    id: 'target.preference-order',
    section: 'targeting',
    claim:
      'Order is role, then label, then text, then css — what a control *is* before where it sits.',
    phase: 1,
  },
  {
    id: 'target.unique-match-required',
    section: 'targeting',
    claim: 'On multiple matches, a hard failure — never "take the first".',
    phase: 3,
  },
  {
    id: 'target.fallback-is-drift',
    section: 'targeting',
    claim:
      'A fallback winning is the drift signal, reported with the run rather than passing silently.',
    phase: 3,
  },
  {
    id: 'target.alternatives-for-names-only',
    section: 'multi-tenant',
    claim: 'Alternatives are admitted for an accessible name and nothing else.',
    phase: 1,
  },

  // ---- contract declarations ----------------------------------------------
  {
    id: 'contract.one-declaration-many-readers',
    section: 'contract declarations',
    claim:
      'Inputs are declared once as a runtime value that the compiler, the MCP schema, the CLI parser and the docs all read.',
    phase: 1,
  },
  {
    id: 'contract.input-type-inferred',
    section: 'contract declarations',
    claim: '`Infer<typeof inputFields>` derives the input type from the declaration.',
    phase: 1,
  },
  {
    id: 'contract.secret-is-a-runtime-marker',
    section: 'contract declarations',
    claim:
      '`secret()` is a runtime marker, because the CLI parser is ordinary code and cannot see a type.',
    phase: 1,
  },
  {
    id: 'contract.answer-union-inferred',
    section: 'contract declarations',
    claim:
      'The result union is inferred from the flow, widened by each `.outcome()` and by `.returns()`.',
    phase: 3,
  },

  // ---- execution ----------------------------------------------------------
  {
    id: 'execution.deterministic-replay',
    section: 'deterministic replay',
    claim:
      'The same inputs produce the same steps, resolved the same way, verified against the same conditions, every run.',
    phase: 3,
  },
  {
    id: 'execution.step-cycle',
    section: 'deterministic replay',
    claim: 'Every step runs resolve, then act or observe, then verify, then record.',
    phase: 3,
  },
  {
    id: 'execution.waiting-is-never-a-sleep',
    section: 'pause and resume',
    claim:
      'A step waits only for its own target to become actionable; anything longer is an explicit bounded pause.',
    phase: 4,
  },
  {
    id: 'execution.recovery-before-judgement',
    section: 'verification order',
    claim:
      'Recovery runs first, because a modal can hide both the checkpoint and the outcome banner.',
    phase: 3,
  },
  {
    id: 'execution.outcomes-before-failure',
    section: 'verification order',
    claim: 'Declared detectors are evaluated in declaration order before a hard failure is raised.',
    phase: 3,
  },
  {
    id: 'execution.retry-gated-per-step',
    section: 'verification order',
    claim: 'Retry is gated per step, not per capability: everything retries except `.commit()`.',
    phase: 3,
  },
  {
    id: 'execution.three-endings',
    section: 'the result',
    claim:
      'A run ends exactly one of three ways: success, a declared business outcome, or a thrown hard failure.',
    phase: 3,
  },

  // ---- pause and resume ---------------------------------------------------
  {
    id: 'pause.four-kinds',
    section: 'pause and resume',
    claim: 'Waiting and human escalation are the same primitive, differing only in the resolver.',
    phase: 4,
  },
  {
    id: 'pause.every-pause-bounded',
    section: 'pause and resume',
    claim:
      'Every pause is bounded; an escalation nobody answers becomes a hard failure with evidence, never a hang.',
    phase: 4,
  },
  {
    id: 'pause.resume-reasserts-a-checkpoint',
    section: 'pause and resume',
    claim: 'After a human touches the session, resume validates a checkpoint before continuing.',
    phase: 4,
  },
  {
    id: 'pause.declared-is-not-an-escalation',
    section: 'pause and resume',
    claim:
      'A pause named in the flow is part of the contract; only an undeclared pause is an escalation.',
    phase: 4,
  },
  {
    id: 'parked.single-shot-resume',
    section: 'parked runs',
    claim: '`resume` is single-shot: a second call on the same id is an error.',
    phase: 4,
  },
  {
    id: 'parked.ttl-kills-the-browser',
    section: 'parked runs',
    claim:
      'Every parked run has a TTL; expiry kills the browser and marks the run a hard failure with evidence.',
    phase: 4,
  },

  // ---- error categories ---------------------------------------------------
  {
    id: 'errors.business-outcome-returned',
    section: 'error categories',
    claim: 'A business outcome is returned as a member of the result union, never thrown.',
    phase: 3,
  },
  {
    id: 'errors.recoverable-is-evidence-only',
    section: 'error categories',
    claim: 'A recoverable condition is recorded as evidence and never surfaced to the caller.',
    phase: 3,
  },
  {
    id: 'errors.hard-failure-is-typed',
    section: 'error categories',
    claim:
      'A hard failure is thrown as a typed exception carrying step id, expected, observed, and the run id.',
    phase: 3,
  },
  {
    id: 'errors.guard-is-exported',
    section: 'master function contract',
    claim: '`isReplayError` is exported, because TypeScript types a `catch` binding as `unknown`.',
    phase: 3,
  },

  // ---- allowlist ----------------------------------------------------------
  {
    id: 'allowlist.judged-on-resolved-url',
    section: 'allowlist',
    claim:
      'The check applies to the resolved URL after redirects, since an allowed host can redirect off-list.',
    phase: 3,
  },
  {
    id: 'allowlist.enforced-inside-the-dsl',
    section: 'allowlist',
    claim:
      'Every navigation is checked where the DSL performs it, because the decision is per navigation.',
    phase: 3,
  },
  {
    id: 'allowlist.leaving-it-is-a-hard-failure',
    section: 'allowlist',
    claim: 'Any navigation outside the replay allowlist is a hard failure.',
    phase: 3,
  },
  {
    id: 'allowlist.host-patterns',
    section: 'allowlist',
    claim: 'The list is concrete hosts; matching is anchored so a lookalike host cannot pass.',
    phase: 1,
  },
  {
    id: 'allowlist.confirmed-not-inferred',
    section: 'allowlist',
    claim:
      'Interfacer proposes hosts and the user confirms; a model that settles them is authoring its own constraint.',
    phase: 9,
  },
  {
    id: 'allowlist.backstops-prompt-injection',
    section: 'allowlist',
    claim:
      'The discovery allowlist is what stops a successful injection becoming a navigation anywhere.',
    phase: 8,
  },

  // ---- effects ------------------------------------------------------------
  {
    id: 'effects.read-may-not-commit',
    section: 'effects',
    claim:
      'A capability declared `read` containing a `.commit()` is rejected at generation, not at replay.',
    phase: 7,
  },
  {
    id: 'effects.irreversible-requires-approval',
    section: 'effects',
    claim: '`reversible: no` requires an approval pause before the `.commit()`.',
    phase: 6,
  },
  {
    id: 'effects.security-effect-forces-attended',
    section: 'effects',
    claim: 'A `securityEffect` other than `none` forces approval and attended execution.',
    phase: 6,
  },
  {
    id: 'effects.published-to-the-caller',
    section: 'effects',
    claim: 'Effects are published in the contract so a caller can see them before invoking.',
    phase: 7,
  },

  // ---- sensitive data -----------------------------------------------------
  {
    id: 'secrets.redaction-is-the-default',
    section: 'the two obligations',
    claim:
      'Secrets are structurally absent rather than filtered: interpolation and `JSON.stringify` both yield `[redacted]`.',
    phase: 1,
  },
  {
    id: 'secrets.never-reach-the-record',
    section: 'the two obligations',
    claim:
      'Nothing sensitive is written: a secret appears nowhere in the record, an attachment, or a thrown error.',
    phase: 3,
  },
  {
    id: 'secrets.revealed-only-in-a-primitive',
    section: 'master function contract',
    claim: 'A secret reaches the page only through an explicit `.reveal()` inside a DSL primitive.',
    phase: 3,
  },
  {
    id: 'dataclasses.govern-evidence',
    section: 'sensitive data',
    claim:
      '`dataClasses` decides what evidence may be captured, from full screenshot down to structure only.',
    phase: 5,
  },
  {
    id: 'dataclasses.masking-at-capture-time',
    section: 'sensitive data',
    claim: 'Redaction happens at capture time, so an unredacted image never exists.',
    phase: 5,
  },

  // ---- evidence -----------------------------------------------------------
  {
    id: 'record.one-append-only-log',
    section: 'evidence',
    claim: 'Evidence is exactly one thing: an append-only run record, one per run.',
    phase: 3,
  },
  {
    id: 'record.common-envelope',
    section: 'evidence',
    claim:
      'Every entry carries run id, capability id, capability version, phase, step id and timestamp.',
    phase: 3,
  },
  {
    id: 'record.same-format-both-phases',
    section: 'evidence',
    claim: 'Discovery and replay records differ in length rather than in kind.',
    phase: 1,
  },
  {
    id: 'record.author-writes-no-log-line',
    section: 'execution',
    claim:
      'A flow author never writes a log line; the primitives are the sole instrumentation point.',
    phase: 3,
  },
  {
    id: 'record.inputs-by-name-only',
    section: 'evidence',
    claim: '`run.started` records which inputs were supplied by name, never by value.',
    phase: 3,
  },
  {
    id: 'record.effect-links-its-approval',
    section: 'the two obligations',
    claim:
      '`effect.performed` names the declared dimension and links the approval entry that authorized it.',
    phase: 5,
  },
  {
    id: 'record.attachments-on-triggers',
    section: 'attachments',
    claim:
      'Rich capture happens on three triggers only: a hard failure, a control transfer, and the commit step.',
    phase: 5,
  },
  {
    id: 'record.stdout-by-default',
    section: 'where it goes',
    claim: 'Entries are emitted one per line as structured JSON, to stdout by default.',
    phase: 3,
  },
  {
    id: 'record.never-stdout-under-mcp',
    section: 'where it goes',
    claim: "An MCP server's stdout is the protocol transport, so the record must never go there.",
    phase: 7,
  },

  // ---- multi-tenant -------------------------------------------------------
  {
    id: 'tenant.entry-point-is-an-input',
    section: 'what actually differs',
    claim:
      'The entry point is an ordinary input, so one artifact serves every tenant differing only by host.',
    phase: 3,
  },
  {
    id: 'tenant.branding-is-absorbed',
    section: 'what actually differs',
    claim:
      'Semantic targeting is branding-invariant: the same recorded flow replays against a restyled tenant.',
    phase: 3,
  },
  {
    id: 'tenant.wording-is-absorbed',
    section: 'what actually differs',
    claim: 'A target chain whose accessible name admits alternatives absorbs the wording tier.',
    phase: 3,
  },
  {
    id: 'tenant.structure-forks',
    section: 'where the line is',
    claim: 'Structural divergence is the one tenant difference that earns its own artifact.',
    phase: 2,
  },
  {
    id: 'variant.stamp-is-written',
    section: 'variants and routing',
    claim:
      'Each project declares what it was recorded against, and the engine emits it at `run.started`.',
    phase: 10,
  },
  {
    id: 'variant.not-a-runtime-check',
    section: 'variants and routing',
    claim:
      'The stamp is deliberately not checked at run time: a host difference is normal, not a signal.',
    phase: 10,
  },

  // ---- generated project --------------------------------------------------
  {
    id: 'project.three-equal-surfaces',
    section: 'generated project',
    claim:
      'CLI, library and MCP server are served by the same master function; none is a wrapper around another.',
    phase: 7,
  },
  {
    id: 'project.secret-refused-on-argv',
    section: 'generated project',
    claim:
      'A `secret()` parameter is refused on argv and read from the environment or stdin instead.',
    phase: 7,
  },
  {
    id: 'project.mcp-omits-secrets',
    section: 'local MCP',
    claim:
      'Fields declared `secret()` are omitted from the published input schema and read from the environment.',
    phase: 7,
  },
  {
    id: 'project.mcp-publishes-outcomes',
    section: 'local MCP',
    claim: 'Business outcomes come back as normal tool results; only hard failures set `isError`.',
    phase: 7,
  },
  {
    id: 'project.resolver-removes-the-suspended-arm',
    section: 'master function contract',
    claim:
      'A caller that supplies a resolver never handles the `suspended` arm, and the overloads make that visible.',
    phase: 4,
  },
  {
    id: 'project.attended-iff-interactions',
    section: 'master function contract',
    claim:
      'Whether a capability needs an attended session is whether `interactions` is non-empty, not a separate declaration.',
    phase: 7,
  },

  // ---- interfacer ---------------------------------------------------------
  {
    id: 'agent.model-never-writes-typescript',
    section: 'the tool surface',
    claim:
      'The model calls tools; Interfacer emits the source. The artifact cannot contain what the vocabulary forbids.',
    phase: 8,
  },
  {
    id: 'agent.acting-and-recording-are-one',
    section: 'the tool surface',
    claim:
      'Calling a tool executes it and appends the step, so the flow cannot drift from what actually happened.',
    phase: 8,
  },
  {
    id: 'agent.sees-the-accessibility-tree',
    section: 'what the model sees',
    claim: 'Each turn the model receives an accessibility snapshot rather than raw markup.',
    phase: 8,
  },
  {
    id: 'agent.screenshot-is-never-a-target',
    section: 'what the model sees',
    claim:
      'A screenshot informs a decision and can never be the target; nothing durable is recordable from a coordinate.',
    phase: 8,
  },
  {
    id: 'agent.harness-holds-the-cap',
    section: 'discovery budget',
    claim: 'The budget is advisory to the model; the harness holds the hard cap.',
    phase: 8,
  },
  {
    id: 'agent.stall-guard-ends-the-run',
    section: 'discovery budget',
    claim: 'A run that stops changing the page ends whatever budget remains.',
    phase: 8,
  },
  {
    id: 'agent.spend-counts-cache-rates',
    section: 'discovery budget',
    claim:
      'Spend is accumulated from `usage`, counting cached and uncached input at their own rates.',
    phase: 1,
  },
  {
    id: 'interview.delta-on-rerun',
    section: 'interview mode',
    claim:
      "On a rerun the interview is a delta: the project's own declarations are the recorded answers.",
    phase: 9,
  },
  {
    id: 'interview.file-is-the-authorization',
    section: 'pre-answered interviews',
    claim:
      'Presence in the interview file counts as confirmation; an absent proposal is a missing answer and fails.',
    phase: 9,
  },
  {
    id: 'interview.never-written-back',
    section: 'pre-answered interviews',
    claim:
      'Interfacer never writes an interview file back, because the project already holds the contract.',
    phase: 9,
  },
  {
    id: 'generation.detectors-are-provoked',
    section: 'generation mode',
    claim:
      'A declared outcome that cannot be reached gets no detector and is reported unverified rather than guessed.',
    phase: 10,
  },
  {
    id: 'generation.no-live-values-in-the-artifact',
    section: 'generation mode',
    claim: 'Live values are held for the run and never written into the project or the run record.',
    phase: 10,
  },
  {
    id: 'generation.seeded-discovery-verifies',
    section: 'variants and routing',
    claim:
      'Seeded discovery keeps only what still resolves, and re-provokes every declared outcome.',
    phase: 10,
  },
];

// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const IGNORED = new Set(['node_modules', 'dist', '.git', 'coverage', '.playwright']);
// Single line only: a greedy match runs past the newline and swallows the
// first word of the code below it.
const COVERS = /@covers[ \t]+([^\n]+)/g;

export interface Coverage {
  readonly claim: Claim;
  /** Repo-relative paths of the test files that declare they exercise it. */
  readonly coveredBy: readonly string[];
}

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

/** Every `@covers` reference in the suite, as claim id to the files naming it. */
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

export function coverage(): Coverage[] {
  const declared = declaredCoverage();
  return CLAIMS.map((claim) => ({ claim, coveredBy: declared.get(claim.id) ?? [] }));
}

/** `@covers` references naming a claim that does not exist. */
export function danglingReferences(): string[] {
  const known = new Set(CLAIMS.map((claim) => claim.id));
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
    const mark = coveredBy.length > 0 ? '✓' : '·';
    lines.push(`    ${mark} ${claim.id.padEnd(44)} phase ${String(claim.phase)}`);
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

  const covered = rows.filter((row) => row.coveredBy.length > 0).length;

  lines.push('', '  by phase', '');
  for (const [phase, tally] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
    const complete = tally.covered === tally.total ? '' : '   <- incomplete';
    lines.push(
      `    phase ${String(phase).padEnd(3)} ${String(tally.covered).padStart(2)}/${String(tally.total).padEnd(2)}${complete}`,
    );
  }

  lines.push(
    '',
    `  ${String(covered)}/${String(rows.length)} claims covered.`,
    '',
    '  A claim from a later phase is pending, not a gap. An uncovered claim from a',
    '  phase already delivered is the number worth looking at.',
    '',
  );

  const dangling = danglingReferences();
  if (dangling.length > 0) {
    lines.push(`  Unknown claim ids referenced: ${dangling.join(', ')}`, '');
  }

  return lines.join('\n');
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  process.stdout.write(report());
}
