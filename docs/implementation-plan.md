# interfacer — implementation plan

This plan turns `design-requirements.md` into an ordered build. Each phase ends at a
green test tier from the design's "testing" section; nothing moves forward on an
unproven seam.

## Understanding this plan is built on

**What it is.** Interfacer turns an English task plus an entry-point URL into a
**capability**: a typed, versioned Node/TypeScript project that performs the task by
driving a web app through Playwright, with no model in the replay path.

**The two phases, one engine.**

- **Discovery** — expensive, non-deterministic, supervised, runs once. An LLM agent
  proposes DSL steps one at a time; the engine executes each against a live headed
  browser; what it observes feeds the next turn. Successful steps accumulate into an
  in-memory `Flow`.
- **Replay** — cheap, deterministic, auditable, runs unattended at volume. The same
  engine walks a finished `Flow`. Determinism is a claim about the decision procedure
  (steps, resolutions, verifications), not about page data.

**Core positions the build must preserve.**

1. **The artifact is a program, not a document.** Source is the only artifact — no
   manifest, no serialized step file. Steps are a closed DSL vocabulary (open,
   fillForm, pressButton, commit, choose, checkpoint, extract, pause*, outcome,
   returns, optional, oneOf). No general branching — the flow is a statically
   enumerable builder.
2. **Contract is expressed in types, projected everywhere else.** `fields()` is a
   runtime value; `Input` is `Infer`'d from it; the result union is `AnswerOf<flow>`
   inferred from `.outcome()` / `.returns()` chaining. CLI parser, MCP schema, and
   docs all read the same runtime declarations. `effects`, `interactions`, `variant`
   likewise.
3. **Ways a task can end are part of the contract.** Business outcome → returned as a
   union arm. Recoverable (slow load, dismissable dialog) → handled in the DSL,
   evidence only. Hard failure → typed `ReplayError` (runId, step, expected,
   observed). Detection order — recover → evaluate declared outcome detectors → hard
   failure — is the reason a business outcome is not a crash.
4. **Guardrails are authored by a human.** Interfacer *proposes* (allowlist, commit
   step, `securityEffect`, budget, `vendor` / `appVersion`); the user *confirms*.
   Presence in an `--interview` file counts as confirmation.
5. **Targets are structured values naming their own strategy** — an ordered chain
   `role → label → text → css`, best-first. Multi-match is always a hard failure,
   never "take the first". A fallback winning is the drift signal. This is also the
   seam that keeps desktop surfaces additive.
6. **One-way dependencies.** `@interfacer/dsl` (wraps Playwright, knows nothing of
   models) ← `interfacer` (CLI + agent, owns the Claude SDK behind one
   `decide(state, tools)` function) and ← generated projects (need only the DSL at
   runtime — no SDK, no API key).

**Secrets.** `secret()` marks a field (parser refuses it on argv → env/stdin; record
redacts it); `Secret<T>` is the value type (`toString` / `toJSON` → `[redacted]`,
explicit `.reveal()` only inside a DSL primitive). `dataClasses` governs what observed
page content may reach the model and the record, masked at capture time.

**Generated project** is used three co-equal ways — CLI (`bin`), imported library,
stdio MCP server — all over one master function. Parked runs (`suspended`) happen only
where there is nowhere to ask (resolver-less library caller, MCP); held in an
in-memory `Map<sessionId, ParkedRun>` beside the browser, TTL-bounded, single-shot
`resume`, die with the process.

**Testing philosophy.** Prefer fakes to mocks (mock-heavy suites pressure you to
reintroduce the rejected abstractions); integration tests drive the engine
(hand-authored `Flow` + `.run()`), never `page.click()`. Five tiers: unit (no
browser) → fixtures (real in-repo HTTP apps) → integration (real browser, real
fixture, no model) → agent-loop (real browser, scripted `decide`) → e2e (live model,
pre-release only).

---

## Phase 0 — Monorepo & toolchain

**Build:** workspace with `packages/dsl`, `packages/interfacer`, `fixtures/`, `e2e/`.
TypeScript strict, one test runner, lint, Playwright browsers. The five test tiers are
separate runner projects: `npm test` runs the three that are fast, deterministic and
free (unit, fixtures, integration); the agent-loop and e2e tiers are invoked
explicitly, because one is slow and the other costs money. `npm run verify` is the
single gate — build, typecheck, lint, format, test.

GitHub Actions runs the gate inside the repository Dev Container on each push to
`master`, after installing the locked dependencies and Chromium.

**Confirmed by:** `npm run verify` green from a clean checkout (`npm ci` onward), and
one smoke test per tier so that no tier can pass by matching zero files.

## Phase 1 — Contract & pure primitives (`@interfacer/dsl`, part 1)

**Build:** `Secret<T>` / `secret()`; `fields()` / `text()` / `Infer`; `Target` type +
`byRole` / `byLabel` / `byText` / `css`; allowlist matcher (against *resolved* URLs,
host patterns); cost accounting from `usage` (separate cached / uncached rates);
run-record entry envelope + per-kind constructors; **verification-order as a pure
function** — `(checkpointResult, detectorResults[], recoveryApplicable) → Recover |
Outcome(i) | HardFailure`.

**Confirmed by (unit tier):** `Secret` yields `[redacted]` through interpolation,
`JSON.stringify`, and inside thrown errors; allowlist matching incl. subdomain
patterns and post-redirect targets; cost math; `fields` / `Infer` as type-level
tests; exhaustive table-driven tests of the verification-order function (its most
important property, made testable without a browser).

## Phase 2 — Fixture applications

**Build:** real HTTP apps in the repo — `clean`, `legacy`, `hostile`, `rebranded`
(restyled + reworded `clean`, same structure), `skewed` (a screen split in two). Each
serves login / search / detail / multi-field action with a confirmation step; real
sessions; redirect chains incl. one off-allowlist redirect; every exceptional
condition on demand (record-not-found, permission-denied, session-expired, unexpected
dialog, slow load, app error). Fixed data, no clock dependence.

Also `npm run fixtures` — start every fixture and print the URLs, then hold until
interrupted. Same servers the tests use, started the same way; it takes no argument
beyond an optional fixture name and port, and it exists so a person can open one in a
browser and click through it.

That is not a convenience. These apps are the stand-in for the back-office systems
Interfacer targets, and how tractable each one is — what `byRole` finds, where the
accessibility tree gives out, whether a screen reads as hostile — is a judgement
someone has to make by looking. It is also how the `hostile` fixture gets to be
genuinely hostile rather than hostile-by-assertion, and the fastest way to check a
`rebranded` restyle really did leave the structure alone. Later phases inherit it: it
is what a human uses to sanity-check a target chain the model proposed, or to see the
screen a failing replay was looking at.

**Confirmed by (fixtures tier, HTTP-level, no engine):** every route + every
exceptional trigger responds as specified; redirects resolve; session expiry works;
`rebranded` is a provable structure-preserving diff of `clean`; identical request →
identical bytes. Plus: the serve script starts every fixture, reports a reachable URL
for each, and shuts them all down cleanly on interrupt — asserted by a test that runs
it, not by having run it once by hand.

## Phase 3 — Execution engine: replay path (`@interfacer/dsl`, part 2)

**Build:** `Flow` builder (stable step ids, capability `id`, input binding); one
engine walking a finished flow; step cycle **resolve → act/observe → verify →
record**; target resolution through the chain (unique match required; multi-match =
hard failure; fallback-won recorded as drift); navigation allowlist check on the
resolved URL, replay allowlist computed from the flow; verification order wired to the
Phase 1 function; retry gating per step (`.commit()` never retried; failed commit
escalates); three endings — `.returns()` / matched `.outcome()` / typed `ReplayError`
subclasses (`CheckpointFailed`, `SessionExpired`, `SurfaceUnavailable`) +
`isReplayError`; `AnswerOf<flow>` inference; run record as JSONL to stdout.

**Confirmed by (integration tier — real browser, real fixture, no model; tests
hand-author a `Flow`):**

- **Determinism:** N replays → identical steps, resolutions, result.
- **Verification order:** each declared outcome is *returned* not thrown; remove the
  detector → same page state becomes a hard failure (the pair proves the ordering).
- **Targeting:** `rebranded` fixture passes unchanged; break the primary strategy →
  fallback carries *and* drift is recorded; ambiguous target → hard failure, not
  first match.
- **Retry gating:** transient step → retried; failed `.commit()` → not retried.
- **Allowlist:** fixture redirects off-list → hard failure on the resolved URL.
- **Redaction (property, not example):** run with a secret sentinel → it appears
  nowhere in the record or any thrown error (scan all output).

## Phase 4 — Pause / resume, parked runs, master-function surface

**Build:** `.pauseUntil` / `.pauseForInput` / `.pauseForApproval` /
`.pauseForOperator`; `Resolver` (one for all kinds), response-vs-kind validation →
hard failure on mismatch; resume re-asserts a checkpoint before continuing; every
pause bounded, expiry → hard failure with evidence (approval expiry = deny); declared
pause = contract, undeclared = escalation; parked runs `Map<sessionId, ParkedRun>`
beside the browser handle, TTL kills the browser + marks hard failure, `resume`
single-shot; master function overloads (`resolver` supplied → no `Suspended` arm;
omitted → `Answer | Suspended`); `InteractionRequest` / `InteractionResponse` /
`resume(sessionId, response)`; `interactions` export; "attended session iff
`interactions` non-empty".

**Confirmed by (integration tier):** a fake resolver answers each of the four kinds
and the run completes; a non-answering resolver makes bound expiry testable per kind;
response/kind mismatch → hard failure; resume with a checkpoint mismatch → hard
failure; second `resume` on an id → error; TTL expiry kills the browser and records
it; `control.transferred` / `control.returned` evidence recorded with who /
how-long / before-after.

## Phase 5 — Evidence completeness, attachments, dataClasses

**Build:** the `effects` value declaration — moved here from Phase 6, because
`dataClasses` governs capture and `effect.performed` has to name a declared
dimension, so evidence cannot be completed without it; Phase 6 keeps enforcement.
Then: full envelope on every entry (run id, capability id, version from
`package.json`, phase, step id, timestamp) + all kinds (`run.*`, `step.*`,
`navigation`, `checkpoint`, `outcome.matched`, `retry`, `pause` / `resume`,
`control.*`, `effect.performed`, `model.turn` [discovery only], `error`); attachments
on triggers only — hard failure, control transfer, `.commit()`; `dataClasses` evidence
matrix (non-identifying → full screenshot + DOM; PII → masked screenshot +
structure-only DOM; full-PAN / SSN → structural only); masking at capture time via
Playwright's mask (no unredacted buffer ever exists) — a capability declares
`dataClasses` for itself and not per node, so PII masks the **value-bearing**
elements and leaves label-bearing ones legible, which is what keeps "the balance
field was present but empty" readable; `dataClasses` governs recorded **URLs** too,
stripping query and fragment at PII and above while the allowlist goes on being
judged on the real URL; `effect.performed` names the
declared dimension and links the approving `pause` entry; record destination config —
stdout default, **MCP → stderr or file, never stdout**, attachments need a configured
directory else skipped + noted in the record.

**Confirmed by (integration tier):** dataClasses matrix — exactly the permitted
artifact types produced per class; secret + PII sentinels scanned across every
attachment and every error; each of the three attachment triggers fires and no
others; `effect.performed` present and linked, and a missing approval is visible in
the record; record never on stdout in MCP mode.

## Phase 6 — Effects & safety enforcement (replay side)

**Build:** replay-time enforcement of the `effects` declaration Phase 5 landed —
approval enforced
before `.commit()`; `reversible: 'no'` requires an approval pause before the commit;
`securityEffect !== 'none'` forces approval + attended (headless refused).
Declarations published in the contract. (Generation-*time* rejections land in
Phase 9 / 10 with the generator.)

**Confirmed by (integration tier):** commit with no prior approval → hard failure; `reversible:no` flow missing its
approval → rejected; `securityEffect` non-none → attended-only enforced.

## Phase 7 — Generated project emission

**Build:** the code generator — given an in-memory `Flow` + contract, emit a complete
self-contained project: `package.json` with `bin`, tsconfig, `inputFields` / `Input`,
master function + overloads, `Answer` / `Suspended` types, `ReplayError` exports, CLI
entry point, stdio MCP server entry point, `variant.ts`, `effects` / `interactions`
exports, generated docs. CLI arg parser from `fields()`, `secret()` refused on argv
(env / stdin). MCP: one tool named for the capability `id`, input schema from
`inputFields` with `secret()` fields omitted (→ env), output schema from the flow's
outcomes, `effects` in the description, companion `resume` tool when `interactions`
non-empty. Generation-time effect rejections (`read` capability containing
`.commit()`, etc.).

**Confirmed by (integration tier — no model):** generate from a hand-built `Flow`,
then —

- `npm i && tsc` compiles; `tsd` confirms the `Answer` union shape.
- CLI: success → JSON + exit 0; business outcome → JSON + exit 0; hard failure →
  stderr + run id + nonzero exit; `--password` on argv refused, taken from env /
  stdin.
- Library: `switch` on `result.status`; `isReplayError` catch; resolver supplied →
  `Suspended` arm absent from the type.
- MCP: server lists exactly one tool with the expected schema (no secret field);
  `call` returns a business outcome as a normal result; a hard failure sets `isError`;
  `suspended` + `resume` tool present when interactions are declared.
- `read` + `.commit()` → generation rejected with a clear message.

## Phase 8 — Agent loop with a fake model

**Build:** `decide(state, tools)` as the single SDK seam (nothing else imports
`@anthropic-ai/sdk`); `API_KEY` / `MODEL` from env, checked before a browser opens or
a question is asked; Interfacer-owned loop — between turns: allowlist check on any
navigation, append the successful step, write run-record entries, accumulate spend
against the budget. Tool surface = DSL verbs (one tool each) + `snapshot` +
`screenshot` + `ask`; acting and appending are one operation. Accessibility snapshot
as the per-turn model input; screenshot as a second tool that can never be a target.
Stall guard; budget cap held by the harness (advisory to the model). Headed session.

**Confirmed by (agent-loop tier — real browser, real fixture, scripted `decide`
returning predetermined tool calls):** step appending from tool calls; cost accounting
from `usage` (cached vs uncached); stall detection ends the run and writes the partial
flow; budget exhaustion ends the run and writes the partial flow; a provider proposing
an off-allowlist navigation is blocked (this is how the prompt-injection backstop gets
exercised); an infinite-loop provider is terminated. Assertions on outcomes only — a
test asserting `decide` was called with particular args is a mock in disguise.

## Phase 9 — Interview mode (+ `interfacer` CLI shell)

**Build:** `npx interfacer <project-name> [--root <dir>] [--interview <path>]`;
location resolution (create if missing / new project if empty / project-update if
occupied) then drop into interview. LLM-conducted Q&A → contract: task description;
inputs (name, type, description); secret marks; output shape; business outcomes;
interaction points; the two `effects` questions (`mutates`, `idempotent`) + the rest
proposed and confirmed; proposed allowlist; proposed budget. `--interview <path>`:
markdown prose, makes the run non-interactive; insufficient answers → exit listing
exactly what is missing; presence in the file = confirmation (an absent allowlist or
`securityEffect` proposal is a *missing answer*, not a silent accept). Delta interview
on rerun: read the project's own declarations (`fields()`, `effects`, `interactions`,
allowlist, flow outcomes) and ask only what the new goal leaves unsettled or
contradicts. No interview file is ever written back.

**Confirmed by (unit + agent-loop tier with fake model):** interview-file prose →
contract object; missing-answer detection lists exactly the gaps; delta interview
against an existing generated project asks only the delta; an unattended run with an
absent allowlist confirmation fails naming the missing answer.

## Phase 10 — Generation mode & seeded discovery (live-model wiring)

**Build:** drive the model through the task against the live app, appending working
steps; a failed step is model input, not a run-ender. Live values held in memory only
— never written to the project or the record; `secret()` redaction applies during
discovery too. Outcome-detector discovery: deliberately provoke each declared outcome
(ask for values chosen to trigger it); an outcome that cannot be reached is **reported
unverified**, never guessed. Commit-step proposal + `securityEffect` proposal + user
confirm. `variant` stamp — `vendor` / `appVersion` proposed from page signals and
confirmed, absent when unknown. Budget at cap: interactive → `pauseForApproval` raises
the ceiling; unattended → stop and write the partial flow for continuation.
Project-update authority: rewrite up to the whole project, no merge around hand edits,
git is the safety net; regenerate what the goal needs, leave the rest. Seeded
discovery: a non-empty seed location → replay the existing flow against the new
tenant, keep steps that still resolve, re-discover the ones that fail, re-provoke
every declared outcome, rewrite `variant`. Interactive end-of-run cost report.

**Confirmed by:**

- **agent-loop tier (fake model):** partial-flow written on stall / budget; live
  values appear in neither the emitted project nor the record; unverified-outcome
  reporting; seeded discovery keeps resolving steps and re-discovers broken ones.
- **e2e tier (live model, real fixture, pre-release / on demand):** discovery reaches
  the goal → emits a project that compiles → that project replays with no model (the
  whole-system through-line); a declared outcome provoked during discovery has its
  detector recorded, not reported unverified.

---

## Sequencing notes

- **Phases 1–5 are the spine** and are almost entirely testable without a model and
  mostly without a browser. If effort is constrained, this is the part that must be
  solid — everything else is callers of it.
- **Phase 2 (fixtures) gates Phases 3–10.** It is unglamorous but every integration,
  agent-loop, and e2e test depends on it. Build `clean` and `hostile` fully before
  Phase 3 and add `rebranded` / `skewed` when Phases 3 / 10 need them.
- **The `decide(state, tools)` seam (Phase 8) does double duty** — provider
  portability and the fake-model injection point — so no test-only abstraction is
  introduced.
- **Deferred by design, not oversight:** desktop surfaces / `Driver` interface,
  capability router, enforcement for `scope` / `external` / `financial`, operator
  console, parked-run crash recovery, interview-file reconstruction. Do not build the
  indirection for these ahead of a second consumer.
- **Open question worth resolving early:** the exact `fields()` / `Infer` /
  `AnswerOf` type machinery (Phase 1) — it is load-bearing for the whole "one
  declaration, read three ways" claim and is the thing most likely to need iteration
  against real TypeScript inference limits.
