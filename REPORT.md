# REPORT

Interfacer takes a task written in plain English, plus an entry point, and produces a
**capability**: a typed, versioned Node/TypeScript project that drives a web
application through Playwright and returns a typed result, with no model in the replay
path.

A model discovers how to do the task once, under supervision. The recorded flow then
replays deterministically and unattended, and that is what production calls. Discovery
is where the variance lives; replay has to be reliable; the artifact between them is a
contract, and that is where most of the design effort went. The full design is in
`docs/design-requirements.md`; runnable commands are in `README.md`.

## 1. Architecture

**The artifact is a project, not a document.** Discovery emits a complete npm package
— the flow as TypeScript source, a typed contract, a CLI, a library entry point, an
MCP server, a provenance stamp — that builds with `tsc` and runs on its own. The flow
is written in a small, closed DSL — a fixed set of verbs (open, fill, press,
checkpoint, extract, and a few more), not arbitrary TypeScript — so it stays readable
top to bottom and analyzable as data. A serialized manifest was rejected: a normalized
copy of the steps is a second thing to keep in sync, and "reviewable and diffable" is
simplest when the artifact is code in git.

**One engine, two callers.** A single execution engine walks a flow step by step.
Replay hands it a finished flow; discovery hands it a flow the model is still
appending to — the model proposes a step, the engine runs it against the live browser,
and what the engine observes becomes the model's next input. Target resolution,
verification order, retry gating and recording are the same code in both cases, so a
successful discovery run is evidence about replay, not about a prototype.

**The agent loop.** Discovery drives Claude (`claude-opus-5` by default, configurable)
through the task with tool calling — observe, decide, act, one step at a time — chosen
for tool use that holds a multi-step plan together and adaptive thinking on the hard
turns. Each turn the model gets an accessibility snapshot (roles and names, not HTML
or pixels — §4 says why), and its tools are the DSL verbs: calling one runs it against
the live session and appends the step on success. A screenshot is a fallback tool for
an ambiguous tree, never a target. Every SDK call sits behind one `decide(state,
tools)` module, so switching provider is a one-module rewrite.

**Three components, dependencies one way.** Node and TypeScript throughout — one
toolchain for Interfacer and the projects it writes, and a contract the compiler
checks rather than a schema kept in sync by hand. `@interfacer/dsl` (vocabulary,
target type, `Secret`, the engine; wraps Playwright, knows nothing about any model) is
the only dependency a generated project has, vendored in as a built package so it runs
anywhere. `interfacer` — the CLI and agent — is an ordinary consumer of it. A
capability in production therefore never loads a model SDK and never needs an API key.

**One surface, no indirection.** Only web/Playwright is implemented, with no `Driver`
interface, no queue, no service, no database. The decision that keeps other surfaces
reachable is that a target is a structured value naming its own strategy, never an
opaque selector (see §4).

**The proxy target** is five HTTP apps in the repo — one application rendered from
clean semantic markup (`clean`) down to nested tables with generated class names
(`hostile`), plus `rebranded` and `skewed` so the multi-tenant claims in §4 are tested
rather than asserted. In-repo rather than a public site keeps terms-of-service, rate
limits and third-party outages out of the suite. Discovery has also been driven by
hand against real sites (§4).

## 2. Artifact schema

The contract is code, in four parts.

**Inputs** are a runtime value; the type is inferred from it.

```ts
export const inputFields = fields({
  url:        text({ description: 'entry point' }),
  username:   text(),
  password:   secret(),
  accountRef: text({ description: 'account to look up' }),
});
export type Input = Infer<typeof inputFields>;
```

A value rather than an `interface` because three consumers need the list at run time —
the MCP schema, the CLI parser (flags, and which to refuse on argv), the generated
docs — and a `type` is erased. Adding a field changes all three at once.

**Outputs** are inferred from the flow. Each `.outcome()` and the final `.returns()`
widens the result union as the flow is chained:

```ts
.outcome(noSuchAccount, i => ({ status: 'account_not_found', accountRef: i.accountRef }))
.returns(({ balance }) => ({ status: 'ok', balance }))
```

Declaring the union separately would allow an arm with no detector (unreachable) or a
detector with no arm (does not compile), with nothing catching the mismatch. Inferring
it means adding an outcome adds the arm, the MCP output schema, and the caller's
obligation to handle it, in one edit.

**Steps** are calls into a closed vocabulary — **open**, **fill**, **press**,
**commit**, **choose**, **checkpoint**, **extract**, three **pause** forms,
**outcome**, **returns**, and two narrow branch forms (**optional**, **oneOf**). It is
small enough to read top to bottom without tracing control flow and closed enough that
a capability can do nothing the DSL does not name. The model calls tools and Interfacer
prints the source; it never writes free-form TypeScript. Values are accessors on the
input (`i => i.username`), never literals, so a flow is parameterized by construction
and holds no credentials or PII.

**Targeting** took the most iteration. Every step, checkpoint and outcome detector
names a control through one `Target` type: an ordered chain of strategies, best first.

```ts
type Target = { by: 'role'; role: string; name?: string }
            | { by: 'label'; text: string }
            | { by: 'text'; text: string }
            | { by: 'css'; selector: string };
```

The order reflects what survives a release: `role` and `label` come from the
accessibility tree and say what a control is; `css` is last because it says where a
control sits in the document, and generated class names and positional paths are
refused outright. Discovery records every strategy that resolves uniquely and still
does after a reload. Replay tries them in order, falling through on zero or many
matches; a fallback winning where the primary failed is recorded as drift, and only a
step where nothing resolves uniquely is a hard failure.

Each project also carries a `variant` stamp — capability id, vendor, app version, the
host discovery ran against, the date — with vendor and version proposed by the model
and confirmed by a human, absent if unknown. Versioning is the project's `package.json`
and git history; the flow declares no version of its own.

## 3. Determinism & error handling

Determinism here is a property of the decision procedure, not the world: same inputs
give the same steps, resolved the same way, checked against the same conditions. The
application's data still varies.

Every step runs one cycle — resolve the target through its chain, act or observe,
verify the postcondition, record what happened. Waiting is never a fixed sleep: a step
waits for its target to become actionable, and any longer wait is an explicit
`.pauseUntil()` with a predicate and a bound, so "slow" and "never" stay distinct.

Errors are classified by who must act on them:

- **Business outcome** — a legitimate answer ("no such account", "not authorized"),
  declared in the flow with the page condition that detects it. Returned as an arm of
  the result union, never thrown.
- **Recoverable** — a transient or known-interstitial condition, handled in the engine
  by waiting, retrying or dismissing. Recorded as evidence, never surfaced.
- **Hard failure** — the flow could not continue and no outcome matched. Thrown as a
  typed exception with step id, expected, observed, and the run id.

**Verification order is why a business outcome is not a crash.** On a failed
checkpoint the engine first attempts declared recovery, then evaluates the outcome
detectors in order and terminates on the first match, then raises a hard failure only
if nothing matched. Recovery goes first because a modal can hide both the checkpoint
and the outcome banner.

**Retry is gated per step.** Resolution, reads, navigation and ordinary presses retry
freely because they commit nothing. `.commit()` is never retried, because a timed-out
commit may already have gone through; it escalates instead. Gating per capability
would forbid retrying the safe steps that precede the one dangerous one.

A run ends in success, a business outcome, or a hard failure; a caller that handles
every arm and catches `ReplayError` has handled everything. Returning outcomes rather
than throwing them matters most at the MCP boundary, where an exception becomes an
opaque tool error and the calling agent can no longer tell "does not exist" from "is
broken". UI drift is not a separate category — rare against a stable application, it
surfaces as recorded drift or a hard failure. `evidence/` has replays covering all
three endings, including two hard failures and one case where a too-broad outcome
detector swallows a bad-credentials failure into a business outcome — a
detector-quality problem a human reviewer catches before approving the artifact, and
the reason discovery reports an unverified outcome rather than guessing one.

## 4. Heterogeneity & multi-tenant

**Surfaces.** The model observes an accessibility snapshot, not HTML or pixels, and so
would an OS accessibility API — the observation seam and the targeting seam are one. A
legacy server-rendered page is the same surface with a worse tree: the chain falls
through to `text` and `css`, and with no semantic markup `css` is all there is and
buys detection, not robustness. A desktop surface is a new strategy in the target
union plus a second engine backend behind the DSL verbs — both additive, and existing
artifacts keep their meaning.

**Multi-tenant.** Most tenant differences are already absorbed by mechanisms the
design has for other reasons, and only structural divergence needs its own artifact.

| difference | absorbed by |
| --- | --- |
| deployment — different host | the entry point is an ordinary input |
| branding — css, layout, class names | semantic targeting; `role`/`label` don't move with a stylesheet |
| wording — "Member" vs "Customer" | a target chain whose accessible name admits alternatives |
| configuration — an optional interstitial | `.optional()` |
| **structure** — a screen split, steps reordered, an outcome reworded | **nothing; forks to its own artifact** |

The first four cover most tenants with no per-tenant artifact. A structural variant is
usually a vendor release, not an institution, so the count tends toward capabilities ×
releases, not × tenants. A base flow with per-tenant patches was rejected: reading one
means reconstructing the effective sequence from a base plus a patch chain.

**Drift detection is behavioural.** The `variant` stamp records what a project was
built against (vendor, version, host, date) but is not a runtime check — one artifact
serving many hosts is intended. Drift shows when a semantic strategy fails and `css`
carries the step; the stamp then says what it drifted from. The realistic failure is
copying a sibling project and editing its URL, which keeps the sibling's detectors and
stamp. **Seeded discovery** is the fix: run Interfacer on the copied project and it
replays the existing flow against the new tenant — keeping steps that still resolve,
re-discovering the rest, re-provoking every outcome, rewriting the stamp.

**Beyond the fixtures.** Discovery has been driven by hand against real sites,
including LinkedIn's login-walled company lookup — the agent reached a generated
project, and replaying the results exposed failure modes the fixtures do not: a URL
assembled from literals rather than navigated to, an ambiguous accessible name
aborting a chain that had a unique fallback behind it. Each became a rule enforced
when the step is proposed. No third-party data is kept as evidence; the committed run
is against a fixture.

## 5. Escalation & handoff

A flow suspends through one primitive with four resolvers. Waiting and human
escalation are the same operation: suspend, let something outside the flow change the
world, resume after re-checking a precondition.

| reason | primitive | on bound expiry |
| --- | --- | --- |
| surface not ready — load, spinner | `.pauseUntil` | retry, then hard failure |
| a value not knowable in advance — MFA | `.pauseForInput` | hard failure |
| a risky step needs approval | `.pauseForApproval` | treated as deny |
| a human must operate the session | `.pauseForOperator` | hard failure |

**Detecting stuck.** In discovery the model calls an `ask` tool when it cannot
proceed, and a stall guard ends a run that stops changing the page regardless of
budget. In replay, a checkpoint that fails all recovery and matches no outcome is a
hard failure carrying step id, expected and observed. A `.pauseForOperator` in the
flow is a declared, expected stop; only an undeclared one is an escalation.

The escalation carries enough to act on: the run record already holds the capability,
the inputs by name, and every step taken with its result, and a control transfer or a
hard failure attaches a screenshot and DOM snapshot of the page it stopped on.

**Taking control.** When a flow pauses for an operator the browser is already headed
(discovery is headed; a generated CLI runs headed when the flow declares an operator
pause or the effects require an attended session). The automation stops driving that
window, the human uses the same window — same browser process, same session and
cookies — and presses Enter to resume. No fresh session, no separate console.

**Handing back.** Resume does not assume where the session is; it re-asserts a
checkpoint first, and a mismatch is a hard failure rather than a blind continuation.
The record captures who held control, for how long, and the state before and after.
Every pause is bounded, so an unanswered escalation becomes a hard failure with
evidence rather than a hang.

**Mocked.** A real-time co-browsing console is out of scope, as the brief allows. What
is real: the pause/resume mechanism, the same-session transfer, bounded expiry,
checkpoint re-assertion, and the evidence; the operator UI is the headed window plus a
keyboard prompt. Where a caller cannot answer a pause (a library host without a
resolver, or MCP), the run parks against its live browser process, resumable only from
that process, with a TTL that kills the browser and fails the run.

## 6. Safety

The interview is a conversation up front that settles the whole contract — inputs,
outcomes, effects, allowlist — before anything is driven. It is normally interactive;
for an unattended run it can be supplied as a markdown file, which then stands as the
authorization record. The file is a convenience, not a schema: once a project exists,
the project's own declarations are the contract, and the file is never written back.

Three guardrails, each established in that interview, enforced during generation
against the non-deterministic model, and enforced again at replay against the fixed
artifact.

**Allowlist.** Derived from the interview, not hand-written, so it cannot drift from
what the capability does. Interfacer proposes concrete host patterns and a human
confirms them — a model settling its own SSO-redirect and CDN edge cases is authoring
its own constraint. Patterns match on host, anchored: `*.mybank.com` admits subdomains
but not the apex, and a bare `*` is refused. The discovery list is wider (the agent
explores pages the flow will not keep) and is the prompt-injection backstop, since
page content is untrusted. The replay list is recomputed from the finished flow,
strictly tighter; a navigation outside it is a hard failure, judged on the resolved
URL after redirects. The check lives in the DSL at each navigation, because a
process-level network rule cannot tell a real load from one an injection asked for.

**Effects.** Every capability declares a typed `effects` object, published in the
contract and the MCP tool description. Each dimension drives a specific check, not a
risk score:

- `mutates: read` containing a `.commit()` is rejected at generation.
- `reversible: no` requires an approval pause before the commit.
- `securityEffect` other than `none` forces approval and an attended session. It
  exists because the other dimensions rate account takeover as low risk — a password
  change is a reversible single-step write, and also the last move of a takeover. Its
  default is inverted: on ambiguous signals Interfacer assumes `authority-change`.
- An approval authorizes the next step, not the run — two irreversible actions ask
  twice.

`scope`, `external` and `financial` are declared but not enforced; each needs
machinery nothing else here uses. The doc says so rather than implying coverage.

**Sensitive data**, two mechanisms. `Secret<T>` protects values the caller supplies:
it renders as `[redacted]` through interpolation and `JSON.stringify`, so reaching the
page takes a deliberate `.reveal()`; it is refused on argv and omitted from the MCP
schema. `dataClasses` protects values the automation observes — a declared capability
property governing evidence: `PII` masks value-bearing nodes and strips snapshot
values, `full-PAN`/`SSN` allow structural evidence only. Masking is at capture time
(Playwright paints over locators before encoding), so an unredacted image never
exists. The same class bounds what page content reaches the model, the leakiest
artifact.

**Limits.** The allowlist trusts DNS and does not pin IPs. `dataClasses` is
capability-wide, so one sensitive field forces the whole capability up a tier. An
MCP-registered capability runs as a fixed identity and cannot act as the calling user
— that case belongs on the library surface, where the host passes the credential per
call. An agent can answer its own approval; the record at least names who did.

## 7. Cuts

**Deferred — the seam exists:**

- Desktop and other surfaces; a new backend is additive, so no `Driver` interface
  until a second surface exists.
- A capability catalog and router; routing sits above a project, and `variant` is
  declared so a router can key on it.
- Enforcement for `scope`, `external`, `financial` — the declarations exist, only the
  checks are missing. This is where I would start next.
- A co-browsing operator console; the headed browser plus a keyboard prompt is the
  handoff surface.
- Parked-run crash recovery; recovery is re-execution from step 0.
- Reconstructing an interview file from a project; a derive-and-exit flag would be a
  reasonable convenience.
- Publishing `@interfacer/dsl`; projects vendor the built package so they run
  anywhere, at the cost that a DSL fix reaches an existing capability only by
  regeneration.
- An automated live-model test tier. The end-to-end thread with a real model is
  validated by hand as AI-assisted sanity runs, one kept in `evidence/`; the rest of
  the suite proves everything with a scripted model and gates on every commit.

**Rejected — would cost a property the design depends on:** a serialized artifact
(drifts from the code); general branching in the DSL (a statically enumerable flow is
what lets the replay allowlist be computed and a step id stay stable); the model
authoring free-form TypeScript; coordinates as targets; override layers across
tenants; a provider abstraction (one module owns the SDK); a model anywhere in the
replay path, including bounded single-step recovery, which reintroduces the
non-determinism replay exists to remove.

**Next, in order:** enforcement for the three declared-only effect dimensions; a
router over `variant`; a second surface, which is where the targeting seam finally
gets tested rather than asserted.

**Stretch goal, delivered.** The agent-facing capability interface works. Every
generated project ships a stdio MCP server exposing its capability as one tool, named
for the capability, with input and output schemas read from the same declarations the
CLI uses and business outcomes returned as normal results rather than errors. It
registers with a local client through a one-line config entry, and `evidence/` shows
one being invoked.

**Scope.** Time-boxed. The full thread is complete and gated — discovery, generated
project, deterministic replay with typed outcomes and error handling, operator
handoff, evidence for both phases — with 800+ tests across four tiers and 100+
design-doc claim markers matched to them by `npm run claims`. Left rough: the
live-model test automation, the three unenforced effect dimensions, multi-tenant
beyond seeded discovery.
