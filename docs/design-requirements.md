# interfacer

Many applications offer no API: the only way in is to drive the UI the way a human operator does. An AI agent that needs to work inside one has no way to reach it.

Interfacer gives it one. Given a task described in English and an entry point, it produces a **capability** — a typed, versioned, parameterized function an agent can call by name, which performs the task through the application's own interface with no model in the loop.

> An LLM discovers the interface once. The discovery is captured as a program. Deterministic replay of that program is how agents invoke it from then on.

Discovery is expensive, non-deterministic, and supervised; it runs once. Replay is cheap, deterministic, and auditable; it runs unattended and constantly, and is what production depends on. The artifact between them is the contract, and it is where this design spends its attention.

Three positions shape what follows:

* **The artifact is a program, not a document.** Steps are expressed in a small TypeScript DSL, so the recorded flow reads as a description of itself. Its contract is expressed in types, so the compiler checks it and every other representation — CLI parser, MCP schema, docs — is projected from it.<sup>[c](testing.md#design-claim-coverage "claim: position.contract-in-types — phase 1")</sup>
* **The ways a task can end are part of that contract.** "No such account" is an answer, not a crash; only genuine breakage is thrown.<sup>[c](testing.md#design-claim-coverage "claim: position.outcomes-are-contract — phase 3")</sup>
* **Guardrails are authored by a human, not resolved by the model.** A model that settles its own constraints has not been constrained.<sup>[c](testing.md#design-claim-coverage "claim: position.guardrails-human-authored — phase 9")</sup>

A statement carrying a <sup>c</sup> makes a claim the test suite is expected to hold it to. The marker names a claim id and the build phase that should prove it — hover it to see both — and `npm run claims` reports which claims the suite actually verifies and which it does not. Adding a statement of that kind means adding a marker; see [testing.md](testing.md#design-claim-coverage) for what earns one.

## scope

Interfacer drives **web applications**, using Playwright. That is the only surface implemented, and the design assumes a browser throughout: an entry point is a URL, a session is a live browser process, and evidence includes DOM snapshots.

Web applications differ in how tractable they are — a modern app with semantic markup and test IDs, or a server-rendered page of nested tables with neither — but that is a question of which targeting strategy identifies a control reliably, not of architecture. Both are the same surface driven the same way, and the recorded flow does not distinguish them.

The surfaces that *are* architecturally different — desktop applications, anything reached through an OS accessibility API rather than a DOM — are deliberately deferred. What keeps them reachable is a single decision: an element target is a structured value that names its own strategy, never an opaque selector string.<sup>[c](testing.md#design-claim-coverage "claim: scope.target-names-own-strategy — phase 1")</sup> A recorded flow therefore says "the control identified this way," and introducing a strategy that resolves against a desktop accessibility tree is purely additive — existing artifacts keep their meaning and none needs rewriting.

That is the whole abstraction. There is no `Driver` interface, no surface registry, no plugin mechanism. A second driver is a mechanical refactor once a second surface actually exists; building the indirection beforehand would be speculative, and a layer that has never had a second implementation is not a proven seam anyway. The browser assumptions above are accepted as such rather than hidden.

## durable artifact

Captured process needs to be expressed in a form suitable for:
* human and LLM reviews
* versioning
* modification
* subsequent repeated execution without LLM present

The perfect design for that is simply code. Therefore, Interfacer produces a complete Node/TypeScript software project at a given location. Once that project is built, this particular interface can be exercised by executing the project's entry point.<sup>[c](testing.md#design-claim-coverage "claim: artifact.is-a-buildable-project — phase 7")</sup>

Because the artifact is a program, its contract is the code (see "master function contract" below). Inputs, outputs, and the declared business outcomes are declared once, in a form that carries its own schema information as ordinary property values and from which the TypeScript types are inferred. The compiler checks the types; the CLI argument parser, the MCP tool schema, and the generated documentation all read that same declaration at run time. There is no second representation to keep in step — changing a field changes the type, the served tool schema, and the accepted command line together.

Arbitrary code would be too much freedom: it can do anything, which makes it neither reviewable at a glance nor analyzable as data. So the steps are not arbitrary TypeScript. They are calls into a small DSL with a fixed vocabulary — open a page, fill a field, press a control, wait on a condition, pause for a human, assert a checkpoint, declare an outcome, extract a value. The vocabulary is narrow enough that a reviewer reads a flow top to bottom without tracing control flow, and closed enough that what a capability can do is bounded by what the DSL offers, while remaining ordinary TypeScript that the compiler checks and an editor completes.

The step sequence is not executed eagerly. DSL calls accumulate into an in-memory flow object carrying an explicit capability `id`, which the engine then walks.<sup>[c](testing.md#design-claim-coverage "claim: artifact.steps-accumulate-not-execute — phase 3")</sup> Nothing is serialized out of that object: there is no manifest, no step file, no exported description.<sup>[c](testing.md#design-claim-coverage "claim: artifact.no-serialized-form — phase 7")</sup> The source is the artifact, and the source is what a human or an LLM reviews and diffs — a normalized data form would only be a second copy of the same facts, free to drift from the code it claims to describe.

Every DSL call carries a stable step id, so errors and evidence refer to `login.submit` rather than to a position that shifts whenever the flow is edited.<sup>[c](testing.md#design-claim-coverage "claim: artifact.stable-step-ids — phase 3")</sup>

Versioning is the project's own. One project is one capability, so the capability's version is the `package.json` version and its history is the repository's — the flow declares no version of its own, because a hand-maintained number beside a real one only drifts from it.<sup>[c](testing.md#design-claim-coverage "claim: artifact.version-is-the-project — phase 7")</sup>

## components

Node and TypeScript throughout, for Interfacer and for the projects it generates:

* The DSL library is shared — generated projects execute against it, and Interfacer executes against it during discovery — so it is an npm package wrapping Playwright.
* A generated project is used in three ways: run from the command line, imported into a caller's codebase as a library, and launched as an MCP server. All three assume npm.
* One toolchain, one dependency graph, one test setup.

Three things are built:

| | what it is | depends on |
| --- | --- | --- |
| `@interfacer/dsl` | npm package: step vocabulary, `Target`, contract declarations, `Secret`, and the execution engine | Playwright |
| `interfacer` | the CLI and agent — interview, agent loop, generation; it writes projects | `@interfacer/dsl`, Claude SDK |
| a generated project | the capability itself: flow, contract, master function, CLI entry point, MCP server | `@interfacer/dsl` |

Dependencies run one way. The DSL library knows nothing about Interfacer, the agent loop, or any model,<sup>[c](testing.md#design-claim-coverage "claim: components.one-way-dependencies — phase 0")</sup> and it is the only component a generated project needs at run time — so a capability in production never loads an SDK and never needs an API key.<sup>[c](testing.md#design-claim-coverage "claim: components.no-sdk-at-replay — phase 7")</sup> Interfacer depends on the DSL library as an ordinary consumer, on the same terms as the projects it writes.

There is **one execution engine with two callers**. Replay is the engine walking a finished flow. Discovery is the same engine walking a flow the model is still appending to: the agent proposes a step, the engine executes it against the live session, and what the engine observes becomes the model's next input. Discovery is not a different way of executing, only a different way of deciding what to execute next<sup>[c](testing.md#design-claim-coverage "claim: components.one-engine-two-callers — phase 8")</sup> — which is what makes "it worked during discovery" a claim about replay rather than about a prototype.

The phases differ in what surrounds the engine, not in the engine:

| | discovery | replay |
| --- | --- | --- |
| driven by | the model, a step at a time | the recorded flow, start to finish |
| the flow is | being written | fixed |
| session | headed, so a human can watch and take over | headless by default |
| model | in the loop | never |
| allowlist | proposed, user-confirmed | computed from the flow |
| ends when | the goal is reached, the budget is exhausted, or progress stalls | the flow returns, an outcome matches, or a hard failure is thrown |

## the DSL

The DSL is the notation a flow is written in: a closed set of TypeScript primitives supplied by the Interfacer DSL library, which wraps Playwright. The same package carries the engine that executes them — see "execution" — but the notation and the runtime are worth reading separately, and this section is the notation.

### vocabulary

The vocabulary is small and closed. Every verb takes a `Target` where it names a control, and takes values as accessors on the input (`i => i.username`) rather than as literals, so a flow is parameterized by construction.<sup>[c](testing.md#design-claim-coverage "claim: dsl.parameterized-by-construction — phase 3")</sup>

An accessor Interfacer generated carries what it reads. `field('username')`, `obtained('mfaCode')`, `extracted('balance')`, `literal('TELLER')` and `join(…)` are ordinary accessors — the same function the engine calls — that also describe their own source, because generation prints a project's source from the accumulated flow and a closure cannot be printed back into source: its text is not recoverable in general, and where it is recoverable it is wrong, since anything the closure captured is not in the emitted file.<sup>[c](testing.md#design-claim-coverage "claim: dsl.accessors-carry-their-source — phase 7")</sup> The two places a flow computes rather than reads are bounded the same way: `.extract()` takes one of a fixed set of parses, and `.outcome()` and `.returns()` take `answer(status, values)`. A plain `i => i.username` stays a legal accessor and runs identically; it simply cannot be emitted, and the generator refuses it by name rather than printing something that looks right and is not.<sup>[c](testing.md#design-claim-coverage "claim: generation.refuses-an-unprintable-flow — phase 7")</sup>

| | verb | does |
| --- | --- | --- |
| navigate | `.open(i => i.url)` | go to an entry point; allowlist-checked on the resolved URL |
| act | `.fillForm(target, i => i.value)` | type into a field |
| | `.pressButton(target)` | activate a control |
| | `.commit(target)` | activate the control that is the point of no return |
| | `.choose(target, i => i.value)` | set a select or radio group |
| observe | `.checkpoint(target)` | assert the expected state was reached |
| | `.extract(name, target, parse)` | read a value out of the page |
| suspend | `.pauseUntil(target, { within })` | wait on a predicate, never a duration |
| | `.pauseForInput(name, { prompt })` | ask a human for a value |
| | `.pauseForApproval(prompt)` | ask a human to authorize |
| | `.pauseForOperator(reason)` | hand the live session to a human |
| terminate | `.outcome(detector, map)` | declare a business outcome and how it is detected |
| | `.returns(map)` | declare the success result |
| branch | `.optional(target, step)` | run a step only if the target resolves |
| | `.oneOf([...])` | take one of a small set of expected screens |

`.checkpoint()` and `.extract()` are the only ways to observe, and `.outcome()` and `.returns()` the only ways to finish. A capability can therefore do nothing the DSL does not name — the bound is structural, not a matter of review discipline.<sup>[c](testing.md#design-claim-coverage "claim: artifact.closed-vocabulary — phase 3")</sup>

`.commit()` is a `.pressButton()` that is understood to be irreversible, and it exists because several rules need to name that step. It is never retried, since a timed-out commit may already have gone through.<sup>[c](testing.md#design-claim-coverage "claim: dsl.commit-never-retried — phase 3")</sup> Approval required by the declared effects must precede it, which is checkable rather than merely intended. It is what the run record marks as the point where the dangerous thing happened. And a reader scanning a flow can see where it stops being reversible. Interfacer proposes which step is the commit during discovery — a submit that leaves a confirmation screen, wording like "transfer" or "delete" — and the user confirms, on the same terms as the other guardrails it proposes rather than decides.

#### branching

There is no general branching. The flow is a builder, so plain TypeScript control flow cannot branch on page state anyway — an `if` runs while the flow is being built, before anything has executed. A statically enumerable step list is what lets the replay allowlist be computed from the flow and lets a step id mean the same thing on every run.<sup>[c](testing.md#design-claim-coverage "claim: dsl.no-general-branching — phase 3")</sup>

What looks like branching is three narrower things:

* **A path that ends the run** — "no such account" — is `.outcome()`. The engine terminates on a match; nothing after it executes.<sup>[c](testing.md#design-claim-coverage "claim: dsl.outcome-terminates — phase 3")</sup>
* **A step that may not be needed** — an intermittent consent screen — is `.optional(target, step)`, a no-op when the target does not resolve.<sup>[c](testing.md#design-claim-coverage "claim: dsl.optional-is-a-noop — phase 3")</sup>
* **A small set of expected screens** is `.oneOf([...])`, each arm naming its detector and its steps. The arms stay enumerable.<sup>[c](testing.md#design-claim-coverage "claim: dsl.oneof-arms-enumerable — phase 3")</sup>

Genuinely divergent tasks are two capabilities, not one with a branch, and choosing between them is the caller's decision.

### targeting

Every step that touches the page names a control, and so does every checkpoint and every business-outcome detector. All three use one `Target` type, so there is a single answer to "how is this identified" rather than three.

A target is not one selector but an ordered chain of strategies, recorded best-first:<sup>[c](testing.md#design-claim-coverage "claim: target.chain-recorded-best-first — phase 1")</sup>

```ts
type Target = { by: 'role'; role: string; name?: string }
            | { by: 'label'; text: string }
            | { by: 'text'; text: string }
            | { by: 'css'; selector: string };
```

The order reflects what survives a release. `role` and `label` describe what a control *is* and what an operator calls it; both come from the accessibility tree, which is also the representation a desktop surface would expose. `text` is next. `css` is last, because it describes where a control sits in a document rather than what it does. Generated class names and positional paths are excluded outright: they encode incidental structure and break on any re-render.<sup>[c](testing.md#design-claim-coverage "claim: target.preference-order — phase 1")</sup>

| | discovery | replay |
| --- | --- | --- |
| strategies recorded | every one that resolves uniquely, ordered by preference | — |
| validated by | must match exactly one element, and still match after a reload | must match exactly one element |
| on multiple matches | rejected, model targets something else | hard failure, never "take the first"<sup>[c](testing.md#design-claim-coverage "claim: target.unique-match-required — phase 3")</sup> |
| on primary miss | — | next strategy in the chain; which one won is recorded |

A fallback winning is the drift signal. The primary strategy failing while a weaker one succeeds means the application changed in a way the artifact survived by luck, and it is reported with the run rather than passing silently<sup>[c](testing.md#design-claim-coverage "claim: target.fallback-is-drift — phase 3")</sup> — the same mismatch the variant stamp catches across tenants.

The limit is worth stating plainly: on a page with no semantic markup, `css` is all there is, and no strategy makes that robust. What the chain buys there is not robustness but detection.

### contract declarations

A TypeScript `interface` is erased at compile time and leaves nothing behind to read. But three consumers need the field list at run time: the MCP server, which must publish an input schema; the CLI parser, which must know the flags and which of them to refuse on argv; and the generated documentation. Declaring the type and then hand-writing a schema for them reintroduces exactly the second representation the artifact-as-program design exists to avoid.

So inputs are declared as a runtime value, and the type is inferred from it:<sup>[c](testing.md#design-claim-coverage "claim: contract.input-type-inferred — phase 1")</sup>

```ts
export const inputFields = fields({
  url:        text({ description: 'entry point' }),
  username:   text(),
  password:   secret(),
  accountRef: text({ description: 'account to look up' }),
});

export type Input = Infer<typeof inputFields>;
// { url: string; username: string; password: Secret<string>; accountRef: string }
```

One declaration, read three ways: the compiler checks the master function against `Input`, while MCP, the CLI and the docs read `input` itself. Adding a field changes all of them at once because there is only one of them to change.<sup>[c](testing.md#design-claim-coverage "claim: contract.one-declaration-many-readers — phase 1")</sup>

`secret()` has to be a runtime marker for the same reason. The rule that a secret is never accepted on argv is enforced by the CLI parser, which is ordinary code and cannot see a type — `password: Secret<string>` in an erased interface is unenforceable. As a value, `secret()` is what the parser reads to refuse the flag and what the run record reads to redact.<sup>[c](testing.md#design-claim-coverage "claim: contract.secret-is-a-runtime-marker — phase 1")</sup>

Results are inferred from the flow rather than declared beside it. Each `.outcome()` and the final `.returns()` widens the flow's result type as it is chained, so the union is a consequence of the steps:<sup>[c](testing.md#design-claim-coverage "claim: contract.answer-union-inferred — phase 3")</sup>

```ts
const flow = new Flow({ id: 'checkAccountBalance', input: inputFields })
  // ... steps ...
  .outcome(noSuchAccount, i => ({ status: 'account_not_found', accountRef: i.accountRef }))
  .outcome(notAuthorized, () => ({ status: 'permission_denied', requiredRole: 'TELLER' }))
  .returns(({ balance }) => ({ status: 'ok', balance }));

export type Answer = AnswerOf<typeof flow>;
```

Declaring the union separately would be the same duplication in a second place: a hand-written arm with no detector is unreachable, a detector with no arm does not type-check, and nothing would catch either. Inferring it means adding an outcome to the flow adds the arm, the MCP output schema, and the caller's obligation to handle it — in one edit.

`effects` and `interactions` are declared the same way, as values the contract publishes rather than types the compiler erases.

## execution

One engine executes flows, and the DSL primitives are the only place it is instrumented. Besides driving Playwright, they emit the run record that constitutes a run's evidence, enforce the allowlist at every navigation, and classify failures according to the error taxonomy below.

A flow author never writes a log line. Because the primitives are the sole instrumentation point, evidence is uniform across every capability, cannot be forgotten, and stays consistent between discovery and replay<sup>[c](testing.md#design-claim-coverage "claim: record.author-writes-no-log-line — phase 3")</sup> — the same calls emit it in both phases.

### deterministic replay

Replay is the engine walking a finished flow with no model attached. It is the path an agent triggers in production, and the only one that runs at volume.

Determinism here is a claim about the decision procedure, not about the world: the same inputs produce the same steps, resolved the same way, verified against the same conditions, every run.<sup>[c](testing.md#design-claim-coverage "claim: execution.deterministic-replay — phase 3")</sup> It does not mean the application returns the same data — a balance changes between runs — and a capability written as though it would is simply wrong.

Every step runs the same cycle:<sup>[c](testing.md#design-claim-coverage "claim: execution.step-cycle — phase 3")</sup>

1. **Resolve** the target through its chain of strategies (see "targeting"). No match, or more than one, ends the step without acting.
2. **Act**, or observe for `checkpoint` and `extract`. A navigation is checked against the replay allowlist at the point it happens, on the resolved URL.
3. **Verify** the step's postcondition.
4. **Record** the step, which strategy resolved it, and what happened, into the run record.

Waiting is never a sleep. A step waits only for its own target to become actionable; any wait longer than that is an explicit `.pauseUntil()` with a predicate and a bound, so "loaded slowly" and "never loaded" stay distinguishable.<sup>[c](testing.md#design-claim-coverage "claim: execution.waiting-is-never-a-sleep — phase 4")</sup>

#### verification order

When a checkpoint or a postcondition is not satisfied, the engine does not fail immediately. In order:

1. **Recover, if the condition is one the flow knows.** A declared interstitial is dismissed, a transient load is waited out, and the verification is retried up to its bound. These never reach the caller; they are recorded as evidence only.<sup>[c](testing.md#design-claim-coverage "claim: execution.recovery-before-judgement — phase 3")</sup>
2. **Evaluate the declared outcome detectors**, in declaration order. The first match terminates the run with that outcome — a legitimate answer, returned rather than thrown.<sup>[c](testing.md#design-claim-coverage "claim: execution.outcomes-before-failure — phase 3")</sup>
3. **Raise a hard failure**, only once nothing above matched.

That order is the whole reason "no such account" is not a crash. Reversing steps 2 and 3 would turn every business outcome into an exception, which is the distinction the error taxonomy exists to preserve. Putting recovery first matters too: a modal can hide both the checkpoint and the outcome banner, so the page has to be legible before either can be judged.

Retry is gated per step, not per capability. Resolution, reads, navigation and ordinary presses are freely retryable because they commit nothing; `.commit()` is never retried, because a timed-out commit may already have gone through and repeating it is worse than failing.<sup>[c](testing.md#design-claim-coverage "claim: execution.retry-gated-per-step — phase 3")</sup> A failed commit escalates instead (see "error categories"). Gating on the capability would forbid retrying the twenty safe steps that precede the one dangerous one, which is how a mutating capability becomes needlessly brittle.

#### the result

A run ends exactly one of three ways, and each maps to a distinct mechanism at the boundary:<sup>[c](testing.md#design-claim-coverage "claim: execution.three-endings — phase 3")</sup>

| ending | produced by | surfaced as |
| --- | --- | --- |
| success | `.returns()` over the extracted values | the success arm of the result union |
| business outcome | the matched `.outcome()` mapper | a declared arm of the same union |
| hard failure | nothing matched | a typed exception carrying step id, expected, observed, and the run id |

Both of the first two are answers, and a caller that handles every arm of the union has handled every answer the capability can give.

Discovery runs on this same engine — the difference is only that steps arrive one at a time from the model instead of from a finished flow, and that a failed step is information the model acts on rather than a run-ending event. Nothing about resolution, verification order, or recording changes between the phases, which is what makes a successful discovery run evidence about replay.

### pause and resume

Execution never sleeps for a fixed duration and hopes. It **pauses** on an explicit resume predicate with a bound; a duration only ever bounds how long that predicate may stay false. `.wait(2000)` cannot distinguish "loaded in 200ms" from "never loaded"; a predicate can.

Waiting and human escalation are the same primitive: suspend, let something outside the flow change the world, resume after re-checking a precondition. They differ only in the resolver.<sup>[c](testing.md#design-claim-coverage "claim: pause.four-kinds — phase 4")</sup>

| pause reason | primitive | resolver | on bound expiry |
| --- | --- | --- | --- |
| awaiting-surface — load, spinner, transient slowness | `.pauseUntil(target, { within })` | polling | retry, then hard failure |
| awaiting-input — a value not knowable in advance (MFA, one-time token) | `.pauseForInput(name, { prompt })` | human, or a registered service | hard failure |
| awaiting-decision — a risky or irreversible step needs approval | `.pauseForApproval(prompt)` | human, returns approve/deny | treated as deny |
| awaiting-action — a human must operate the session (unexpected dialog, uncovered screen) | `.pauseForOperator(reason)` | human, on the live session | hard failure |

Two rules:

* **Declared vs undeclared.** A pause named in the flow is part of the contract, not an incident: MFA on every login is expected, and a capability that declares it is simply attended rather than broken. Only an undeclared pause is an escalation.<sup>[c](testing.md#design-claim-coverage "claim: pause.declared-is-not-an-escalation — phase 4")</sup>
* **Resume re-asserts a checkpoint.** After a human touches the session the flow cannot assume where it is, so resume validates a checkpoint before continuing; a mismatch is a hard failure, not a blind continuation.<sup>[c](testing.md#design-claim-coverage "claim: pause.resume-reasserts-a-checkpoint — phase 4")</sup>

Every pause is bounded — an escalation nobody answers becomes a hard failure with evidence, never a hang.<sup>[c](testing.md#design-claim-coverage "claim: pause.every-pause-bounded — phase 4")</sup> Control transfer is recorded as evidence: who held control, for how long, and before/after state.<sup>[c](testing.md#design-claim-coverage "claim: record.control-transfer-is-evidence — phase 4")</sup>

### error categories

Errors are categorized by who needs to act on them, and each category surfaces through a different mechanism:

* **Business outcome** — a legitimate answer to the question the caller asked ("no such account", "not authorized"). The run succeeded: it found out something true. Returned as a member of the master function's result union, never thrown.<sup>[c](testing.md#design-claim-coverage "claim: errors.business-outcome-returned — phase 3")</sup> Every business outcome a capability can produce is declared in the flow together with the page condition that detects it.
* **Recoverable** — a transient or known-interstitial condition: a slow load, a dismissable dialog, a retryable timeout. Handled inside the DSL by waiting, retrying, or dismissing. Recorded in the trace as evidence, but never surfaced to the caller.<sup>[c](testing.md#design-claim-coverage "claim: errors.recoverable-is-evidence-only — phase 3")</sup> Retry is gated per step: everything retries except `.commit()`, which never does, because a timed-out commit may already have gone through. A failed commit escalates instead of retrying.
* **Hard failure** — the flow could not continue and no declared outcome matched: a checkpoint never satisfied, an expired session, an unreachable surface, an unexpected application error. Thrown as a typed exception carrying the step id, what was expected, what was observed, and the run id that locates the rest in the record.<sup>[c](testing.md#design-claim-coverage "claim: errors.hard-failure-is-typed — phase 3")</sup>

Detection order matters. When a checkpoint is not satisfied, the engine first evaluates the declared business-outcome detectors, and raises a hard failure only if none of them match. Without that ordering every business outcome would arrive as a crash, which is precisely the distinction this taxonomy exists to preserve.

UI drift is deliberately not a top-level category. The target applications are stable business systems, so drift is rare relative to genuine runtime conditions; when it does occur it surfaces as a hard failure like any other.

## interfacer

Interfacer is the tool that runs discovery and writes projects. A run is two phases: an interview that establishes the capability's contract, and generation, which discovers the flow against the live application and emits the project.

Both phases are conversational, and the conversation does not end when the interview does. The user stays in the loop through generation — supplying live values, watching the browser work, taking over when the model cannot proceed, and confirming what Interfacer proposes as it discovers. A run is one continuous session with a human in it. The non-interactive path exists so a capability can be re-recorded where nobody is present; it is not the normal way to record one.

The human is reached in prose: a question goes out as text and the answer comes back as text, whether it is an interview question or a proposal put for confirmation.<sup>[c](testing.md#design-claim-coverage "claim: session.human-channel-is-prose — phase 9")</sup> Generation reaches the same person the same way, for the live values the model asks for as it needs them. That is deliberately not the `Resolver` a running capability pauses on: a pause has three kinds and three answer types because a flow stopped mid-step needs a value of a known shape before it can continue, and the engine rejects an answer that does not match the kind it asked for. A discovery question has no such shape — the answer is whatever the person says, and turning that into a contract answer is the model's job rather than the channel's. Widening the pause response to carry arbitrary text would loosen a validation that exists to catch a caller's mistake, for the sake of a case no flow has.

Two shapes travel that channel: an open question, and a proposal put for confirmation. A proposal is separate because it is answered by acceptance rather than by content, and because the value has to be visible in the asking — what Interfacer proposes rather than asks is exactly what a person would otherwise wave through.

Interfacer is a Node/TypeScript application and runs on macOS (arm and Intel), Linux amd64, and Windows under WSL.

### cli

Interfacer is run with `npx interfacer`, so there is nothing to install beyond Node and Playwright's browsers.

```
npx interfacer <project-name> [--root <dir>] [--interview <path>]
```

* `project-name` — short name for the interface (`mybank-interface`); it names both the directory and the capability
* `--root` — on-disk location for generated projects, defaults to the current directory
* `--interview` — path to a file of pre-answered interview questions; supplying it makes the run non-interactive

The goal and the entry point are deliberately not arguments. They are established in the interview, interactively or from the interview file: a goal is a paragraph rather than a flag, and the interview has to interrogate it anyway to get the contract out of it.

When Interfacer runs,
* it checks if specified location ("root/project-name") exists, and creates it if missing
* if the location is empty, Interfacer sets up a new project there
* if it already holds a project, that project becomes the starting point (project update)
* once location is determined, Interfacer drops into "interview" mode

Once written, a generated project is an ordinary repository. It is committed, edited, refactored and evolved like any other code, and Interfacer has no claim on it between runs. Pointing Interfacer at that location again puts it back under Interfacer's authority: Interfacer rewrites whatever it must, up to the whole project, and does not try to merge around hand edits. Git is what makes that safe — a rerun lands as a reviewable diff, and anything overwritten is recoverable from history.

How much is rewritten is decided by the goal rather than by a policy. Interfacer regenerates what the stated task needs in order to succeed and leaves the rest alone, so adding one outcome to an otherwise unchanged capability touches very little, while a materially different task rewrites most of the flow.

### interview mode 

In interview mode, Interfacer will use LLM to ask the user the series of questions. User will:
* provide description of the task ("login to mybank.com, locate my checking account, retrieve account balance")
* provide the task's inputs — a name for each, its type where it is not a string, and a short description of what it is for. The descriptions are not decoration: they become the field descriptions in the generated MCP schema, which is what a calling agent reads to decide what to pass
* mark which of those inputs are **secrets** — credentials, tokens, anything that must never be persisted or logged ("password is a secret"). A secret is declared with `secret()` in the generated contract, so it is redacted in the run record and refused on the command line — both enforced at run time rather than by convention
* provide description of task's expected output — the shape returned when the task succeeds ("json object with one property, balance, and numeric value")
* provide the **business outcomes** the task can legitimately end in besides success ("the account may not exist", "the user may not be authorized to view it"). Each becomes an arm of the result union; generation mode is then responsible for discovering the page condition that detects it
* provide the **interaction points**: any place the task must stop and ask for something partway through — a value that cannot be known in advance ("login sends an MFA code to my phone") or an approval for a risky step. Each becomes a declared, typed interaction in the contract
* answer two **effects** questions: "does this only read, or does it change something?" and, if it changes something, "if this ran twice by mistake, would that be a problem?" The remaining effect dimensions are proposed by Interfacer and confirmed by the user
* confirm the **allowlist** Interfacer proposes from the task description — the concrete hosts the automation may visit
* confirm the **discovery budget** Interfacer proposes — a cost ceiling, which matters only when a later run is unattended

The last questions are the ones users do not volunteer on their own, so Interfacer asks them directly: "what else can happen instead of success?" and "will this ever stop and ask you for something?" An outcome that is not declared here cannot be returned, cannot appear in the generated MCP schema, and will surface at replay time as a hard failure. A declared interaction, conversely, tells a caller in advance that this capability cannot run unattended. The interview is therefore where the caller's error, interaction, and safety contract is actually decided, not an afterthought of generation.

Where Interfacer proposes rather than asks, the user still confirms. A model that resolves its own guardrails is authoring the constraint it is bound by.

On a rerun against an existing project, the interview is a delta rather than a repeat. The project's own declarations are the recorded answers<sup>[c](testing.md#design-claim-coverage "claim: interview.rerun-is-a-delta — phase 9")</sup> — `fields()`, `effects`, `interactions`, the allowlist, and the outcomes the flow declares — so Interfacer reads those and asks only about what the new goal leaves unsettled or contradicts. Re-running an unchanged capability should cost a confirmation, not a second pass through every question.

Reading the code rather than a sidecar file is what keeps a hand-edited project honest: an edit to the flow is visible to the next interview immediately, instead of being contradicted by a stale record of what was once asked for.

Once Interfacer confirms with the user that all the parameters are described, Interfacer will switch to "Generation Mode".

#### pre-answered interviews

`--interview <path>` supplies answers up front. The file is a starting point rather than a replacement: Interfacer already has to judge whether it has enough to proceed, so a partial file simply narrows what is left to establish.

The file is markdown prose, not a structured document. The interview is a conversation an LLM conducts, and the same model reads the file — a formal schema would have to be maintained alongside the questions and would buy nothing that reading the prose does not. It also means a human can write one by hand, which matters because the file is the authorization record.

The flag also makes the run non-interactive. If the answers are insufficient, Interfacer exits listing which ones are missing rather than blocking on a question nobody is present to answer; filling those in and re-running is the loop.

Presence in the file counts as confirmation, which matters for the two things Interfacer proposes rather than asks — the allowlist and `securityEffect`. Unattended there is nobody to confirm them, so a proposal for either that is absent from the file is a missing answer and fails, rather than being accepted silently. A human wrote and committed the file, so the file is the authorization record.<sup>[c](testing.md#design-claim-coverage "claim: interview.file-is-the-authorization — phase 9")</sup>

The file is an input only. Interfacer never writes one back<sup>[c](testing.md#design-claim-coverage "claim: interview.never-written-back — phase 9")</sup>, because there would be nothing to write that the project does not already hold: the inputs are the `fields()` declaration, the outcomes are inferred from the flow, the interactions, effects and allowlist are exported declarations. Recording them again as prose would be a second copy of the contract, free to drift the moment someone edits the flow by hand — and the flow is meant to be edited by hand.

So the file bootstraps a capability where no project exists yet. Once one does, the project is the record, and copying an input file to record the same capability against another tenant is still available but is the weaker path; seeded discovery from a sibling project is the better one.

Going the other way — needing a file for a project that already exists, in order to run it unattended somewhere else — is a reconstruction rather than a record: derive a draft from the declarations, edit it, commit it. That is a deferred convenience rather than something the design turns on (see "non-goals").

#### discovery budget

An unattended run needs a spending bound, since nothing is watching it. The budget is expressed as **cost** — the only unit meaningful to whoever authorized the run — and lives in the interview file alongside every other answer.

Interactively there is nothing to bound, so Interfacer only reports: an interactive run ends by saying what it cost. That number is what a human writes into the interview file when they later set one up to run unattended, so the ceiling is informed by a run that was actually paid for rather than guessed at.

A file that reaches an unattended run with no budget is missing an answer like any other, and the run exits saying which. There is no fallback default, because a default nobody chose is not an authorization.<sup>[c](testing.md#design-claim-coverage "claim: agent.no-default-budget — phase 9")</sup>

Interfacer accumulates spend from the `usage` on every response, counting cached and uncached input at their own rates, since discovery resends history constantly.<sup>[c](testing.md#design-claim-coverage "claim: agent.spend-counts-cache-rates — phase 1")</sup> The budget is also given to the model as an advisory ceiling so it paces itself, but the model is only informed: the harness holds the hard cap.<sup>[c](testing.md#design-claim-coverage "claim: agent.harness-holds-the-cap — phase 8")</sup> A run that stops changing the page ends the same way whatever budget remains<sup>[c](testing.md#design-claim-coverage "claim: agent.stall-guard-ends-the-run — phase 8")</sup>, since an agent retrying the same thing should not spend the rest of the ceiling doing it.

Interactively, reaching the cap is a `pauseForApproval` rather than a failure — approving raises the ceiling and continues. Unattended there is nobody to ask, so the run stops, and Interfacer writes out the partial flow so a re-run with a raised budget continues from it instead of restarting.

### generation mode

Generation is where the flow is discovered. Interfacer drives the model through the task against the live application, and every step that works is appended to the flow — so the artifact accumulates as a by-product of doing the task, rather than being reconstructed afterwards from a transcript.

Steps are proposed one at a time and validated by execution before they are kept. The model names a target and an action, the engine performs it, and what the engine observes becomes the model's next input. A step that fails is information the model acts on — a different target, a different approach — not a run-ending event.

**Live values.** Discovery needs real values to work with: a username that logs in, an account that exists. The model asks for them as it needs them, matching the input parameters the interview established. They are held for the life of the run and never written anywhere — not into the project, not into the run record. A live value for a `secret()` input is a real credential, and the redaction that applies to it at replay applies here.

**Outcome detectors.** The interview declared what the task can end in besides success. Generation has to find the page condition that detects each one, which means deliberately reaching those states rather than only the happy path — so it asks for values chosen to provoke them: an account reference that does not exist, a user without the entitlement. A declared outcome that cannot be reached during discovery gets no detector, and Interfacer reports it as unverified rather than recording a guess.<sup>[c](testing.md#design-claim-coverage "claim: generation.detectors-are-provoked — phase 10")</sup> Recording a guess would be worse than nothing: the arm would exist in the contract while the condition it names arrived at replay as a hard failure.

**The commit step.** Where the task changes something, Interfacer proposes which step is the point of no return and the user confirms, so `.commit()` is marked in the flow rather than inferred at replay. The same pass proposes `securityEffect` from what the pages give up — a password field being written rather than used to log in, labels like MFA, signer, role or entitlement, routes such as `/security`, confirmation text along the lines of "your password has been changed" — and the user confirms that too.

The DSL never embeds live values. Values collected during the interview become typed input parameters, and the flow refers to them by accessor rather than by literal, so the generated artifact is parameterized by construction and contains no credentials or PII.<sup>[c](testing.md#design-claim-coverage "claim: generation.no-live-values-in-the-artifact — phase 10")</sup>

The end result looks something like this:

```ts
const balanceField = [byLabel('Current balance'), css('#balance-value')];

const checkAccountBalanceFlow = new Flow({ id: 'checkAccountBalance', input: inputFields })
  .open(i => i.url)
  .fillForm([byLabel('Username'), css('#login_field')], i => i.username)
  .fillForm([byLabel('Password'), css('#password')], i => i.password)   // secret(): redacted everywhere
  .pressButton([byRole('button', 'Sign in'), css('input[type="submit"]')])
  .pauseForInput('mfaCode', { prompt: 'Enter the 6-digit code sent to your device' })
  .pauseUntil([byRole('heading', 'Account summary')], { within: '30s' })  // predicate, never a sleep
  .fillForm([byLabel('Account number'), css('#account-ref')], i => i.accountRef)
  .pressButton([byRole('button', 'Look up'), css('#lookup')])

  // Declared business outcomes: legitimate answers, not failures.
  .outcome(byText('No such account'),
    i => ({ status: 'account_not_found', accountRef: i.accountRef }))
  .outcome(byText('Not authorized'),
    () => ({ status: 'permission_denied', requiredRole: 'TELLER' }))

  .checkpoint(balanceField)
  .extract('balance', balanceField, Number)
  .returns(({ balance }) => ({ status: 'ok', balance }));

// Execute the flow live in a visible window during discovery.
checkAccountBalanceFlow.run(liveValues, { headless: false });
```

Each target is a chain, best-first: the semantic strategy that should survive a release, backed by the selector that was observed to work. The flow declares no result type — it is inferred from the `.outcome()` and `.returns()` calls — and no version, which is the project's. This capability only reads, so it contains no `.commit()`.

Generation ends when the goal is reached — the checkpoint holds and the declared result can be extracted — or when the budget or the stall guard stops it first, in which case the partial flow is still written and a later run continues from it.<sup>[c](testing.md#design-claim-coverage "claim: generation.partial-flow-is-written — phase 10")</sup>

### the agent loop

Interfacer is an AI agent that drives an LLM through tool calling. It uses the Claude API through the official TypeScript SDK (`@anthropic-ai/sdk`), with `claude-opus-5` as the default model and adaptive thinking enabled. The model id is configuration, not a constant.

A turn can come back with nothing to act on. A provider refusal arrives as an assistant turn carrying no content at all, which is indistinguishable at the seam from a turn that simply called no tool, and either one leaves the loop with no tool result to report — so the alternative to saying something is an empty message, which the provider rejects and which poisons every request built from that transcript afterwards. Interfacer answers both the same way: it says what was missing and asks for a tool call, which is well-formed and changes the input, so the next turn is not a replay of the one that produced nothing.<sup>[c](testing.md#design-claim-coverage "claim: agent.turn-without-a-call-recovers — phase 8")</sup> A refusal is additionally named rather than left to look like indecision: the refusal and its category are recorded, and refusals that persist end the run as refused rather than as a stall, because the two ask different things of whoever reads the record.<sup>[c](testing.md#design-claim-coverage "claim: agent.refusal-is-named — phase 8")</sup>

Credentials come from the environment: `API_KEY`, and `MODEL` where the default is overridden. Neither name mentions a provider — the one module that owns the SDK is also the one that maps them onto whatever that provider expects. Neither is a command-line argument either, for the same reason a generated capability refuses secrets on argv: argv lands in shell history and process listings. Interfacer checks for the key before it opens a browser or asks the first question, so a missing key costs a second rather than an entire interview.

The key is a discovery-time credential only. A generated project never calls a model, so it never needs one; nothing about the key reaches the project, the flow, or the run record.

Provider portability is a seam, not an abstraction layer. Every SDK call lives in one module behind a single `decide(state, tools)` function, and nothing else in Interfacer imports the SDK<sup>[c](testing.md#design-claim-coverage "claim: agent.one-sdk-seam — phase 8")</sup> — so moving to another provider means rewriting that one module. There is no provider registry, no lowest-common-denominator message format, and no attempt to support two providers at once.

The model is given the contract the interview established — the inputs, the declared outcomes it must find detectors for, the effects, and the allowlist — and its job is to produce a flow that satisfies it.

#### what the model sees

Each turn the model receives an **accessibility snapshot** of the current page: the roles, names and structure a screen reader would get, rather than raw HTML.<sup>[c](testing.md#design-claim-coverage "claim: agent.sees-the-accessibility-tree — phase 8")</sup> Three reasons, heaviest first.

* It is the same vocabulary as the targets it has to produce. A model shown `button "Look up"` proposes `byRole('button', 'Look up')`. A model shown a wall of `<div>`s proposes a brittle CSS path, because that is all it was given to work with — the observation format decides the locator quality.
* It degrades better than markup. A server-rendered page of nested tables yields a poor tree, but a poor tree is still smaller and more navigable than the markup behind it, and text content survives either way.
* It is what an OS accessibility API would also provide, so the observation seam and the targeting seam are the same seam.

The snapshot is accompanied by the identifying attributes of the page's **value-bearing** nodes — the same `input`, `textarea`, `select`, `output`, `td`, `dd` and test-id-carrying elements the evidence rules treat as values. Such a node has no role and no accessible name, so the tree shows its text and nothing to name it by, and a model asked to extract from one has only a positional path left — which targeting excludes outright.<sup>[c](testing.md#design-claim-coverage "claim: agent.value-nodes-are-identified — phase 8")</sup> Attribute *names* rather than values, which is the line the structural DOM snapshot already draws.

A **screenshot** is a second tool rather than a default, for when the tree is ambiguous — three unlabelled buttons, a layout question structure does not answer. It informs the decision and can never be the target: nothing durable can be recorded from a coordinate<sup>[c](testing.md#design-claim-coverage "claim: agent.screenshot-is-never-a-target — phase 8")</sup>, so a control located by eye must still be committed as an element identified in the tree.

Page content is untrusted input. Whatever the model reads may contain instructions, and the allowlist is what bounds the consequence of that succeeding.

#### the tool surface

The model's tools are the DSL vocabulary, one tool per verb. Calling a tool executes it against the live session and, if it succeeds, appends that step to the flow.

| tools | effect |
| --- | --- |
| `open`, `fillForm`, `pressButton`, `commit`, `choose` | perform the action; append the step on success |
| `checkpoint`, `extract`, `outcome`, `returns` | verify against the current page, then append the declaration |
| `snapshot`, `screenshot` | observe; record nothing |
| `ask` | put a question to the human — a live value, or help when stuck |

Acting and recording are one operation, so the flow cannot drift from what actually happened<sup>[c](testing.md#design-claim-coverage "claim: agent.acting-and-recording-are-one — phase 8")</sup>; there is no separate "write down what you did" step to get wrong, and no transcript to reconstruct the artifact from afterwards.

The model never writes TypeScript. It calls tools, Interfacer emits the source from the accumulated flow, and the artifact therefore cannot contain anything the vocabulary does not permit.<sup>[c](testing.md#design-claim-coverage "claim: agent.model-never-writes-typescript — phase 8")</sup> Letting the model author code directly would put arbitrary TypeScript in the one place the design most needs to stay bounded.

#### between turns

Interfacer owns the loop rather than delegating it to an SDK helper, because four things happen between turns and all of them are its responsibility: the allowlist is checked on any navigation, the successful step is appended, the run record gets its entries, and spend is accumulated against the budget.

The loop ends when `returns` has been called and verified, which is what "the goal is reached" means concretely — or when the budget or the stall guard stops it, or the user does.

## generated project

The end result of generation phase is sequence of DSL expressions that achieves the desired task without LLM present. This typescript code is placed into desired location and set up to be executable as a Node package

Generated project is fully self-contained, it has appropriate npm setup, etc. 

It is meant to be used in three ways, and the same master function serves all of them:

* **from the command line**, as an executable — for a human running the capability directly, and for the demo path
* **as a library**, imported into a caller's codebase and called as an ordinary typed function
* **as an MCP server**, so yet another agent can discover the capability by name and invoke it with typed arguments

None of the three is primary, and none is a wrapper around another.<sup>[c](testing.md#design-claim-coverage "claim: project.three-equal-surfaces — phase 7")</sup>

The package declares a `bin` entry, so the capability runs as `npx <project-name>` and takes its inputs as command-line arguments (`--username user35`), the flags being read from the same `input` declaration. Parameters declared with `secret()` are never accepted on argv: the parser refuses the flag and takes the value from the environment or stdin instead<sup>[c](testing.md#design-claim-coverage "claim: project.secret-refused-on-argv — phase 7")</sup>, so it does not land in shell history or in process listings.

### master function contract

There is a well defined master function that takes a well-typed input object and returns a well-typed result union. These declarations are the capability's contract: the CLI parser, the MCP schema and the generated documentation read them rather than restating them.

`secret()` and `Secret<T>` are the two halves of one mechanism, and it is worth being precise about which is which. `secret()` marks a *field* in the declaration: it is what the CLI parser reads to refuse the flag and what the run record reads to redact. `Secret<T>` is the type of the *value* the caller then supplies for that field:

```ts
declare const secretBrand: unique symbol;

export interface Secret<T = string> {
  readonly [secretBrand]: true;
  reveal(): T;          // explicit, and the only way to read the value
  toString(): string;   // always "[redacted]"
  toJSON(): string;     // always "[redacted]"
}
```

`Secret` makes redaction the default rather than a logging convention that has to be remembered at every call site: string interpolation and `JSON.stringify` both yield `[redacted]`,<sup>[c](testing.md#design-claim-coverage "claim: secrets.redaction-is-the-default — phase 1")</sup> so a secret can reach the page only through an explicit `.reveal()` inside a DSL primitive.<sup>[c](testing.md#design-claim-coverage "claim: secrets.revealed-only-in-a-primitive — phase 3")</sup>

The input is the `fields()` declaration the interview produced, and both the type and the result union are derived rather than written:

```ts
export const inputFields = fields({
  url:        text({ description: 'entry point' }),
  username:   text(),
  password:   secret(),
  accountRef: text({ description: 'account to look up' }),
});

export type Input = Infer<typeof inputFields>;
// { url: string; username: string; password: Secret<string>; accountRef: string }

export type Answer = AnswerOf<typeof checkAccountBalanceFlow>;
// { status: 'ok'; balance: number }
//   | { status: 'account_not_found'; accountRef: string }
//   | { status: 'permission_denied'; requiredRole: string }

export type Suspended =
  { status: 'suspended'; sessionId: string; request: InteractionRequest };

// A resolver is supplied: the engine asks and loops internally, never suspending.
export function checkAccountBalance(
  input: Input,
  opts: { resolver: Resolver },
): Promise<Answer>;

// No resolver: nowhere to ask, so the run parks.
export function checkAccountBalance(
  input: Input,
): Promise<Answer | Suspended>;
```

`suspended` is a control state, not a business outcome, and it is precisely what you get when no resolver is available. The overloads make that visible in the type: a caller that supplies a resolver never handles the arm at all.<sup>[c](testing.md#design-claim-coverage "claim: project.resolver-removes-the-suspended-arm — phase 4")</sup>

```ts
export interface InteractionRequest {
  kind: 'input' | 'approval' | 'operator';
  name: string;
  prompt: string;
  secret: boolean;
  expiresAt: string;    // ISO-8601
}

export type InteractionResponse = Secret<string> | boolean | 'done';
export type Resolver = (req: InteractionRequest) => Promise<InteractionResponse>;

export function resume(
  sessionId: string,
  response: InteractionResponse,
): Promise<Answer | Suspended>;
```

One resolver handles every kind rather than a callback per kind: the set of kinds will grow, and caller policy ("deny every approval when unattended") then lives in one place instead of three. The CLI's keyboard reader is just the built-in resolver. That resolver answers pauses in a capability that is *running*; it is not how Interfacer reaches the person during discovery, which is described under **interfacer** above.

The cost of that choice is that the response type is not tied to the request kind — nothing in the signature stops a caller answering an `approval` with a string, or an `input` with `true`. The engine validates the response against the kind it asked for and treats a mismatch as a hard failure.<sup>[c](testing.md#design-claim-coverage "claim: pause.response-validated-against-kind — phase 4")</sup> A per-kind callback would have made this a compile error, at the price of triplicating the policy every caller has to write; keeping the policy in one place is worth a runtime check.

Declared interactions are published alongside the contract, so a caller knows before invoking that this capability will stop and ask. Whether it needs an attended session is not declared separately — it is whether `interactions` is non-empty.<sup>[c](testing.md#design-claim-coverage "claim: project.attended-iff-interactions — phase 4")</sup> Declaring both would let a capability announce an MFA pause and claim to run unattended, and nothing would catch the contradiction.

```ts
export const interactions = {
  mfaCode: { kind: 'input', secret: true, prompt: 'Enter the 6-digit code sent to your device' },
} as const;

export const effects = {
  mutates: 'read',
  reversible: 'yes',
  securityEffect: 'none',
  scope: 'single',
  external: 'none',
  financial: 'none',
  idempotent: true,
  dataClasses: ['non-identifying'],
} as const;
```

The result union carries success and every declared business outcome, so a caller that handles all arms of the union has handled every answer the capability can give. Hard failures are thrown instead, as typed exceptions:

```ts
export class ReplayError extends Error {
  readonly runId: string;         // correlates with the run record
  readonly step: string;          // the step id, e.g. 'login.submit'
  readonly expected: string;
  readonly observed: string;
}

export class CheckpointFailed extends ReplayError {}
export class SessionExpired extends ReplayError {}
export class SurfaceUnavailable extends ReplayError {}

export function isReplayError(e: unknown): e is ReplayError;
```

`isReplayError` is exported because TypeScript types a `catch` binding as `unknown` and has no `throws` clause.<sup>[c](testing.md#design-claim-coverage "claim: errors.guard-is-exported — phase 3")</sup> Without the guard, consumers lose the typing at the one place they need it.

### parked runs

Most runs never park. The CLI, and any library caller that supplies a resolver, answer the pause in place and carry on within the same call — nothing is stored and there is no session to speak of.

A run parks only where there is nowhere to ask, which is two cases: a library caller that deliberately omits a resolver because it wants to handle interaction itself, and MCP, where a tool cannot call back into its caller mid-execution, so parking is forced rather than chosen.

A parked run is held in memory beside its browser handle, in a plain `Map<sessionId, ParkedRun>` owned by the process running the browser. None of this is a service: no store, no database, no queue, no cross-host addressing. The run's state *is* a live browser process rather than a serializable record, so `sessionId` is a handle to that process, not a key anyone else could look up — it is resumable only from the process that parked it.

How many exist follows from the surface. A CLI invocation holds none. A library host or an MCP server can hold several at once, one per concurrent call, which is the only reason this is a map rather than a single slot.

Two rules stop it leaking. Every parked run has a TTL, and expiry kills the browser and marks the run a hard failure with evidence, so a forgotten session cannot strand a browser process.<sup>[c](testing.md#design-claim-coverage "claim: parked.ttl-kills-the-browser — phase 4")</sup> And `resume` is single-shot: a second call on the same id is an error.<sup>[c](testing.md#design-claim-coverage "claim: parked.single-shot-resume — phase 4")</sup>

Deliberate cut: parked runs die with the process. A live browser cannot be restored mid-flow, so recovery after a crash means re-running from step 0 with restored storage state — re-execution, not resume.

### how to use generated project

Everything above the boundary — the flow, the contract, the effects — is the same code in all three cases. What differs is only how `Answer`, `Suspended` and the thrown errors map onto each surface's conventions:

* **run from command line** — success and business outcomes both print the result object as JSON and exit 0, because both are answers. A hard failure prints the error and the run id to stderr and exits nonzero, adding where the attachments went if it was configured to write any — it knows, because it configured it. A `suspended` result is handled in-process by a default resolver that prints the prompt and reads the response from the keyboard, then calls `resume` — so the command still looks like a single blocking invocation. For `operator` pauses the browser is already headed: the flow simply stops driving it, the human uses that same window, and Enter signals resume.
* **integrate into larger codebases using master function** — call it directly: `switch` on `result.status` for outcomes, `try`/`catch` with `isReplayError` for hard failures. Supply a `resolver` and the `suspended` arm never appears; omit it only if the host wants to park runs itself.
* **make it available as MCP for other LLMs** — the tool's input and output schemas are read from the `input` and `effects` declarations and the flow's outcomes, so a calling LLM sees `account_not_found` as a declared possible answer and gets each field's description as written in the interview. Business outcomes come back as normal tool results; only hard failures set `isError`.<sup>[c](testing.md#design-claim-coverage "claim: project.mcp-publishes-outcomes — phase 7")</sup> `suspended` is returned as a normal result with a companion `resume` tool, because an MCP tool cannot call back into its caller mid-execution — the agent obtains the value however it can and calls `resume` with the session id.

The MCP case is the sharpest argument for returning business outcomes rather than throwing them. An exception crossing the MCP boundary becomes an opaque tool error, and the calling agent can no longer distinguish "this account does not exist" from "the application is broken" — which is the one distinction it most needs in order to decide what to do next.

### local MCP

Generation emits an MCP server entry point beside the CLI one, so the capability can be registered with a local client — Claude Code, Claude Desktop — without anything being written by hand.

It speaks over **stdio**, which is what "local" means here: the client launches the server as a child process, and there is no listener, no port and no network surface. Registering it is a config entry naming the command.

The server exposes one tool, because one project is one capability. The tool is named for the capability `id`, its input schema is read from `inputFields` and its output schema from the flow's declared outcomes, so a calling agent sees `account_not_found` as a possible answer rather than meeting it as an error. The `effects` declaration is published in the tool description, so an agent can see that a capability writes, moves funds or changes authority before deciding to call it. Where the capability declares interactions, a companion `resume` tool is exposed alongside.

**Secrets are not tool arguments.** Fields declared with `secret()` are omitted from the published input schema and read from the server process's environment instead.<sup>[c](testing.md#design-claim-coverage "claim: project.mcp-omits-secrets — phase 7")</sup> A calling agent has no business holding operator credentials for a back-office system, and a tool schema that asks for a password invites precisely that. It is the same rule as the CLI's refusal on argv, applied to a different kind of caller.

They reach the server as environment, set once where the client registers it:

```json
{
  "mcpServers": {
    "mybank-balance": {
      "command": "npx",
      "args": ["mybank-interface"],
      "env": { "PASSWORD": "${MYBANK_PASSWORD}" }
    }
  }
}
```

The value should be a reference to wherever the operator already keeps secrets, not a literal in a config file that syncs between machines.

The consequence is that a capability runs as a **fixed identity**: whoever registered the server chose the account it operates as, and no agent can make it act as anyone else. That is mostly a feature — a confused or compromised agent is bounded by one account's permissions, rather than by whatever credential it could talk somebody into supplying. It is also a real limit. A capability that must act as the *calling* user cannot be exposed this way, and that case belongs on the library surface instead, where the host holds the credential and passes it as a `Secret` on each call.

**An agent's approval is not authorization.** A capability whose effects require approval returns `suspended` carrying an approval request, and the calling agent can technically answer `resume` with `true`. That satisfies the mechanism and not the intent, so a capability that requires human approval should not be registered for unattended use — the point of the pause is that a person sees it. The run record names who resolved each interaction, so at minimum the distinction is visible afterwards.

Aggregating many capabilities behind one server — a catalog an agent browses by name — is a natural extension and deliberately not built. That is routing, and it belongs above a single generated project rather than inside one.

## safety policy

Three guardrails, each doing something different in each phase. The interview is where they are established, generation is where a non-deterministic model is constrained, and replay is where a deterministic artifact is held to what was authorized.

| | interview | generation | replay |
| --- | --- | --- | --- |
| **allowlist** | Interfacer proposes hosts from the task description, the user confirms | enforced on every navigation; the wider list, since the agent explores pages the flow will not keep | recomputed from the finished flow, strictly tighter; leaving it is a hard failure |
| **effects** | `mutates` and `idempotent` asked outright, the rest proposed and confirmed | `securityEffect` and the commit step proposed from what the pages reveal; a `read` capability that commits is rejected here, not at replay | approval enforced before `.commit()`, which is never retried; the declarations are published so a caller sees them before invoking |
| **sensitive data** | `dataClasses` declared | bounds what page content may reach the model — the transcript is the leakiest artifact, because the model reads pages directly | bounds what the run record may capture; masking happens at capture time |

A guardrail that is only established and never enforced is documentation. Each row therefore has an entry in all three columns, and where enforcement is missing — the three dimensions listed under "effects" as declared but not enforced — the doc says so rather than implying coverage.

### allowlist

The allowlist is derived from the interview rather than hand-written, so it cannot drift away from what the capability actually does. There are two of them, with different sources and lifetimes:

| | discovery | replay |
| --- | --- | --- |
| source | proposed by the LLM from the task description, **confirmed by the user** | computed from the recorded flow |
| width | wider — the agent explores pages that will not survive into the final flow | exactly the origins the artifact touches |
| purpose | guardrail on a non-deterministic model | tripwire: leaving it means the application changed |

The confirmation step is not optional. "login to mybank.com" leaves `auth.mybank.com`, an SSO redirect to a third-party identity provider, and `cdn.mybank.net` undecided; a model that settles those edge cases for itself is authoring its own constraint. Interfacer proposes concrete host patterns, the user confirms, and the confirmed list is stored explicitly in the project.<sup>[c](testing.md#design-claim-coverage "claim: allowlist.confirmed-not-inferred — phase 9")</sup>

The discovery allowlist is also the prompt-injection backstop: the agent reads page content, page content can contain instructions, and the allowlist is what stops a successful injection from becoming a navigation anywhere.<sup>[c](testing.md#design-claim-coverage "claim: allowlist.backstops-prompt-injection — phase 8")</sup>

The replay allowlist requires no user input at all and is strictly tighter. Any navigation outside it is a hard failure.<sup>[c](testing.md#design-claim-coverage "claim: allowlist.leaving-it-is-a-hard-failure — phase 3")</sup>

Both lists match on the **host**, and matching is anchored. A pattern is a concrete host, or a single leading `*.` standing for any subdomain of one: `mybank.com` admits `mybank.com` alone, and `*.mybank.com` admits `auth.mybank.com` and `a.b.mybank.com` but deliberately not the apex, which must be listed in its own right. Ports are not part of a pattern, because the unit here is the host.<sup>[c](testing.md#design-claim-coverage "claim: allowlist.host-patterns — phase 1")</sup> Anchoring is the point rather than a detail: `mybank.com.attacker.net` is a different host that a suffix match would admit, and an allowlist a lookalike passes is not one. For the same reason a pattern quietly covering one host more than the user read is the failure worth avoiding — so the apex is not folded into its own wildcard, and a bare `*` is refused outright rather than denied at run time, being a total bypass wearing the shape of a guardrail.

Which *actions* are permitted is the other half of the same guardrail, and it is `mutates`: a capability declared `read` may not contain a `.commit()`, and one that does is rejected at generation rather than at replay.<sup>[c](testing.md#design-claim-coverage "claim: effects.read-may-not-commit — phase 7")</sup> Hosts bound where the automation may go; `mutates` bounds what it may do once there.

Enforcement lives inside the DSL rather than around the process. Every navigation is checked where the DSL performs it<sup>[c](testing.md#design-claim-coverage "claim: allowlist.enforced-inside-the-dsl — phase 3")</sup> — `.open()`, an activation that navigates, a popup or new tab — because the decision is per navigation: a process-level network permission cannot tell a legitimate page load from one an injection asked for. The check applies to the *resolved* URL after redirects, since an allowed host can redirect off-list.<sup>[c](testing.md#design-claim-coverage "claim: allowlist.judged-on-resolved-url — phase 3")</sup>

### effects

Every capability declares its effects. They are published in the contract so a caller can see them before invoking<sup>[c](testing.md#design-claim-coverage "claim: effects.published-to-the-caller — phase 7")</sup>, and each dimension drives a specific enforcement rather than a vague risk score.

| dimension | values | enforcement |
| --- | --- | --- |
| `mutates` | read / write | a `read` capability containing a `.commit()` is rejected |
| `reversible` | yes / compensable / no | `no` requires an approval pause before the `.commit()`<sup>[c](testing.md#design-claim-coverage "claim: effects.irreversible-requires-approval — phase 6")</sup> |
| `securityEffect` | none / authority-change / control-override | anything but `none` forces approval and attended execution<sup>[c](testing.md#design-claim-coverage "claim: effects.security-effect-forces-attended — phase 6")</sup> |
| `idempotent` | yes / no | published so a caller knows whether re-invoking after a timeout is safe |
| `dataClasses` | non-identifying / PII / full-PAN / SSN | governs redaction and what evidence may be captured |

Enforcement keys off individual dimensions rather than a rolled-up risk score, which would lose the ability to say that "read-only but touches everything" is fine.

An approval authorizes **the step that follows**, not the run: it is spent by the commit it precedes, so a flow with two irreversible actions asks a human twice.<sup>[c](testing.md#design-claim-coverage "claim: effects.approval-is-spent — phase 6")</sup> One approval standing for every commit in a run would record somebody as having authorized an action they were never shown, which is the opposite of what the pause is for.

Two are correctness rather than policy. `dataClasses` gates evidence capture. `idempotent` is the caller-facing question — *if this ran twice by mistake, would that be a problem?* — and it is deliberately not what gates retry inside a run; `.commit()` does that, per step. The two are related but not the same: a capability can be safe to re-invoke because the application deduplicates, while still containing a step that must never be retried blind.

`securityEffect` exists because the others score account takeover as low risk. Changing a password is `write`, `reversible` (change it back), and single-step — and is the last move of taking over an account. The harm is not that the effect is permanent but that it changes **who can access the account afterwards**: passwords, MFA devices, authorized signers, the registered email or phone that fraud teams treat as the highest-risk non-monetary field. `control-override` is its sibling — lifting a fraud hold, whitelisting a payee — granting no access and moving no money, but disabling a control. The default is inverted for this dimension alone: where discovery's signals are ambiguous Interfacer assumes `authority-change` and makes the user say otherwise, because a false negative here is an account-takeover flow running unattended.

Three further dimensions are declared but not enforced, because the enforcement each would need is machinery nothing else in this design uses. They are recorded in the contract so a caller can see them, and they are where this would grow next:

* **`scope`** — single / bounded(N) / unbounded. Enforcing `bounded` needs a runtime counter.
* **`external`** — whether the action notifies a customer or reaches a third party. Its enforcement would be identical to `reversible: no`.
* **`financial`** — `moves-funds(cap)`, where the amount parameter would be checked against the cap before the commit.

### sensitive data

Two requirements collide: evidence needs a rich signal on failure, and regulated data must never be persisted into logs. A failure screenshot of a back-office screen showing an account number and an SSN is precisely the forbidden thing. `dataClasses` arbitrates:<sup>[c](testing.md#design-claim-coverage "claim: dataclasses.govern-evidence — phase 5")</sup>

| dataClasses | evidence permitted |
| --- | --- |
| non-identifying (balance, status) | full screenshot, DOM snapshot |
| PII | screenshot with sensitive nodes masked; DOM snapshot with values stripped, structure kept |
| full-PAN, SSN | no pixels; structural evidence only |

Little diagnostic power is lost, because debugging needs structure rather than values: "the balance field was present but empty" localizes a fault as well as the figure itself would.

Which nodes are the sensitive ones is not a judgement the engine can make: `dataClasses` is declared for the **capability**, so nothing marks an individual element. What the engine can do is tell the halves of a screen apart. `input`, `textarea`, `select`, `output`, `td`, `dd` and anything carrying a test id hold **values**; `label`, `th`, `dt`, headings, legends and button text hold their **names**. Masking the first and keeping the second is what makes the paragraph above true — "the balance field was present but empty" only reads that way if you can still see which field it was.<sup>[c](testing.md#design-claim-coverage "claim: dataclasses.masks-values-not-names — phase 5")</sup> A DOM snapshot follows the same line: element structure and the attributes that name a control are kept, and text nodes and every value-bearing attribute are dropped.

A recorded **URL** is observed data like any other, and is bounded the same way. An application that puts an account reference in a query string would otherwise write a value the caller supplied straight into a `navigation` entry, having never passed it through a field. At PII and above the query and fragment are stripped and the origin and path kept, because a navigation nobody can locate is not evidence. The allowlist goes on being judged on the real URL: what is bounded is the record, not the decision.<sup>[c](testing.md#design-claim-coverage "claim: dataclasses.governs-recorded-urls — phase 5")</sup>

Redaction happens **at capture time**, not before writing. Playwright's screenshot takes a mask of locators and paints over them before encoding, so an unredacted image never exists in a buffer or a temp file.<sup>[c](testing.md#design-claim-coverage "claim: dataclasses.masking-at-capture-time — phase 5")</sup>

This applies to more than screenshots. Traces embed DOM and network bodies, and the leakiest artifact is the discovery transcript, since the LLM receives page content directly as input. `dataClasses` therefore also governs what may be sent to the model and what the transcript retains.

`Secret` and `dataClasses` solve different halves of one problem: `Secret` protects values the caller supplies, `dataClasses` protects values the automation observes.

## evidence

Evidence is exactly one thing: an append-only **run record**, one per run.<sup>[c](testing.md#design-claim-coverage "claim: record.one-append-only-log — phase 3")</sup> Screenshots and DOM snapshots are attachments on an entry, not a second artifact — there is no separate trace, log, or transcript to correlate against.

Discovery and replay produce the same record, and the interview writes into it too — one file for a session, whatever part of it produced an entry.<sup>[c](testing.md#design-claim-coverage "claim: record.same-format-both-phases — phase 1")</sup> Each adds entry kinds the others have no use for, but the format is one format, so a run that was recorded and a run that replayed are read side by side. The interview drives nothing — there is no browser and no flow yet — so it contributes no step, navigation or attachment; what it contributes is the account of how the contract those steps answer to was settled.

Every entry carries the same envelope — run id, capability id, capability version from `package.json`, phase, step id, timestamp<sup>[c](testing.md#design-claim-coverage "claim: record.common-envelope — phase 3")</sup> — and then a kind. One field relaxes: an interview entry carries no capability version, because the interview precedes the project whose `package.json` would supply it.<sup>[c](testing.md#design-claim-coverage "claim: record.interview-has-no-version — phase 9")</sup> Every other field is known before the first question: the capability id comes from the project name the run was invoked with.

| kind | carries |
| --- | --- |
| `run.started` / `run.finished` | which inputs were supplied (names, never values) and the terminal status<sup>[c](testing.md#design-claim-coverage "claim: record.inputs-by-name-only — phase 3")</sup> |
| `step.started` / `step.finished` | the step id and which target strategy resolved it |
| `navigation` | the resolved URL, and whether the allowlist permitted it |
| `checkpoint` | satisfied or not |
| `outcome.matched` | which declared detector fired |
| `retry` | step id, reason, attempt number |
| `pause` / `resume` | reason, which resolver answered, how long it waited |
| `control.transferred` / `control.returned` | who took the session, for how long, and the state before and after |
| `effect.performed` | the declared dimension the step carries, and the approval entry that authorized it<sup>[c](testing.md#design-claim-coverage "claim: record.effect-links-its-approval — phase 5")</sup> |
| `model.turn` | discovery and the interview: the model's stated reason for the step, the tool it called, and what the turn cost |
| `answer.recorded` | interview only: which contract fields a turn settled, and the authority that admitted them — a person, or a sentence quoted from the interview file |
| `proposal.put` | interview only: the guardrail Interfacer proposed, and whether it was accepted |
| `error` | category, what was expected, what was observed |

`model.turn` is what makes the record answer "what did the agent do **and why**" rather than only what it did. It is also the reason discovery and replay records differ in length rather than in kind.

The interview records what was decided and on whose authority, never what was said.<sup>[c](testing.md#design-claim-coverage "claim: record.interview-records-decisions-not-prose — phase 9")</sup> Every piece of content the record writes elsewhere passes through a policy: `dataClasses` decides whether a screenshot is masked, whether a snapshot keeps its values, whether a URL is redacted. The interview is the phase that has not yet declared what data it may handle — `dataClasses` is one of the things it settles — so writing a person's answers there would be the one place content is recorded under no policy at all. It would also record the wrong thing. What makes a guardrail auditable is that the allowlist was accepted by a person at a known point in the session, not the sentence they typed; and the answers themselves are not lost, since the settled contract is emitted as source into the project. So an `answer.recorded` names the fields a turn settled and the authority behind them, and a `proposal.put` names the guardrail and whether it was accepted — the trail that turns "a human authored the guardrails" from a claim into something a reader can check afterwards.

#### attachments

Rich capture is expensive and sensitive, so it happens on triggers rather than continuously: a hard failure, a control transfer, the `.commit()` step, and an outcome whose state was reached but which no detector matched.<sup>[c](testing.md#design-claim-coverage "claim: record.attachments-on-triggers — phase 5")</sup> Those are the four moments where somebody will later want to see the screen — a failure that must be diagnosed, a handoff whose before and after must be evidenced, the point of no return, and the page a detector will have to be written against by hand.<sup>[c](testing.md#design-claim-coverage "claim: record.attachments-on-undetected-outcome — phase 5")</sup> An outcome Interfacer could reach but could not detect is the one a person has to finish by hand, and the screen it was on is the only thing that makes that possible.

What may be captured is `dataClasses`, and the masking happens at capture time rather than before writing, so an unredacted image never exists (see "sensitive data"). An attachment is referenced from its entry, never inlined, and is written only where a directory has been configured to hold it.

#### the two obligations

**Nothing sensitive is written.** Secrets are structurally absent rather than filtered<sup>[c](testing.md#design-claim-coverage "claim: secrets.never-reach-the-record — phase 3")</sup> — `Secret` yields `[redacted]` through interpolation and `JSON.stringify`, so writing one out takes a deliberate `.reveal()`. Observed values are bounded by `dataClasses`.

**A dangerous step is unmistakable.** Someone auditing a run should be able to answer *did anything irreversible happen, and was it authorized* by reading the record, not by inferring it from a `step.finished` on a button press. That is what `effect.performed` is for: it names the declared dimension and links the `pause` entry that approved it. It is what turns the effects declarations from a claim in the contract into something observable after the fact — and if an approval is missing where one was required, the record shows that too.

#### where it goes

The record is a log, and is configured like one. Entries are emitted one per line as structured JSON, to **stdout by default**, so a run is pipeable and needs no path convention at all.<sup>[c](testing.md#design-claim-coverage "claim: record.stdout-by-default — phase 3")</sup> A destination can be configured to send it to a file instead.

One case is not a preference but a constraint: an MCP server's stdout is the protocol transport, so the record must never go there. It goes to stderr, or to a configured file.<sup>[c](testing.md#design-claim-coverage "claim: record.never-on-mcp-stdout — phase 5")</sup>

Attachments are the exception, because a screenshot cannot go to a stream. They require a directory to be configured; where none is, rich capture is skipped and the record says so rather than silently producing less than the reader expects. Making attachments opt-in this way also suits the data-handling story: capture happens where someone has chosen to put the files.

Nothing here imposes a layout. `evidence/` is a convention for the demo path, not a rule, and the design says nothing about rotation, shipping, or aggregation — the record is a log stream, and whatever the operator already does with those applies to it.

## multi-tenant

Hundreds of institutions run the same vendor products, configured, branded and versioned differently, and the question is how an artifact is reused across them rather than re-recorded for each. The answer is not one mechanism but a line: most tenant differences are absorbed by things this design already does, and only structural divergence earns a second artifact.

### what actually differs

| difference | example | absorbed by |
| --- | --- | --- |
| deployment | same product, different host | the entry point is an ordinary input — one artifact serves every tenant differing only here<sup>[c](testing.md#design-claim-coverage "claim: tenant.entry-point-is-an-input — phase 3")</sup> |
| branding | logo, colours, stylesheet, class names, layout chrome | semantic targeting: `role` and `label` do not change when a stylesheet does<sup>[c](testing.md#design-claim-coverage "claim: tenant.branding-is-absorbed — phase 3")</sup> |
| wording | one institution says "Member" where another says "Customer" | a target chain whose accessible name admits alternatives<sup>[c](testing.md#design-claim-coverage "claim: tenant.wording-is-absorbed — phase 3")</sup> |
| configuration | a consent interstitial some tenants enable | `.optional()`, where the step is genuinely skippable |
| structure | a screen split in two between releases, steps reordered, an outcome banner reworded | nothing — this needs its own artifact<sup>[c](testing.md#design-claim-coverage "claim: tenant.structure-forks — phase 2")</sup> |

The first four are the bulk of the hundreds, and none needs a per-tenant artifact. That matters more than the fork rule below, because branding and wording are what most tenants actually differ by. A flow whose targets lead with `role` and `label` is branding-invariant by construction — the same property that makes those strategies preferred in "targeting", earning its keep a second time.

Alternatives are admitted for an accessible *name* and nothing else.<sup>[c](testing.md#design-claim-coverage "claim: target.alternatives-for-names-only — phase 1")</sup> That is deliberate: it absorbs the wording tier without becoming a general specialization mechanism, because a target that could vary its strategy or its structure per tenant is an override layer wearing a different hat.

### where the line is

The line sits at structure, and it is a trade rather than a principle.

Reusing one artifact across many tenants means less to maintain, and the risk that a tenant differs more than assumed and the flow resolves onto the wrong control without saying so. Forking per variant means precision, and a trivially auditable answer to "what ran against this institution", at the cost of many artifacts. Drawing the line at structure puts the cheap high-volume differences on the reuse side and the dangerous ones on the fork side — and, more importantly, makes crossing it detectable rather than silent.

What is deliberately not built is the obvious alternative: a base flow with per-tenant patches that insert, reorder or replace steps. Such a layer is a flow with indirection, and reading one means reconstructing the effective sequence from a base plus a chain of patches — precisely the reasoning a recorded artifact exists to remove.

### variants and routing

A project serves a **variant**, not a tenant, and many tenants map to one variant. Each project declares what it was recorded against:

```ts
export const variant = {
  capability: 'checkAccountBalance',
  vendor:     'CoreBankingCo',
  appVersion: '11.4',
  recordedAgainst: 'fcu-demo.example.com',
  recordedOn:      '2026-03-14',
} as const;
```

Interfacer writes it during generation, from three sources. The capability id, the host discovery actually ran against and the date it ran are known directly. `vendor` and `appVersion` are proposed by the model from whatever the pages reveal<sup>[c](testing.md#design-claim-coverage "claim: variant.stamp-is-written — phase 10")</sup> — a product name in a title bar, a build string in a footer — and confirmed by the user, on the same terms as the allowlist. Where nobody knows, the field is absent rather than guessed: a fabricated version is worse than a missing one, because it reads as fact. A rerun rewrites the declaration like anything else Interfacer generates.

It is read in three places. The engine emits it into the run record at `run.started`, so every run carries the provenance of the artifact that produced it. Seeded discovery reads a sibling's copy to know what a new variant is diverging from. And a router could key on it — routing belongs above a single generated project rather than inside one, so this declaration exists so that a router can be written, not because one is.

It is deliberately **not** a runtime check.<sup>[c](testing.md#design-claim-coverage "claim: variant.not-a-runtime-check — phase 10")</sup> The obvious one — does the host match `recordedAgainst`? — is wrong by construction, because the entry point is an input parameter and one artifact serving many hosts is the intended tier-1 behaviour. A host difference is normal, not a signal.

Detection is behavioural instead, and the design already emits it:

* **Drift shows in resolution.** A run where the semantic strategy failed and `css` carried it is running against an application that has moved from what was recorded. A declared outcome detector that never matches on a tenant where that outcome does occur is the same signal, arriving later.
* **The stamp turns that into a diagnosis.** The realistic failure is not re-recording but copying a sibling project and pointing it at another institution, which leaves outcome detectors matching wording the new tenant does not use and quietly degrades a business outcome into a hard failure. The drift signal says something is wrong; the stamp in the same record says what the artifact was built against, which is what makes the cause findable rather than guessable. It works for that precisely because whoever copied the project changed the URL and did not think about this file — so it goes on naming the host the flow was really recorded against.
* **Seeded discovery** is the cure rather than a guard, and it is not a separate mechanism. It is the project-update path with the seed copied in from elsewhere: copy a sibling project to a new location and run Interfacer there, the location is non-empty, and the existing flow becomes the starting point.

What Interfacer does with a seed is verify it rather than trust it. The delta interview reads the copied declarations and asks only what the new tenant changes, which is usually the entry point alone. Generation then replays the existing flow against the new tenant rather than discovering from nothing<sup>[c](testing.md#design-claim-coverage "claim: generation.seeded-discovery-verifies — phase 10")</sup>: steps that still resolve are kept, steps that fail are re-discovered, and every declared outcome is provoked again — wording is precisely what differs between tenants, and a detector carried across unverified is the failure this section exists to prevent. The `variant` declaration is rewritten from what this run observed.

That is also exactly the difference between seeding and the failure it guards against. Copying a project and editing the URL by hand keeps the sibling's detectors and the sibling's stamp, both now describing a different institution. Copying it and running Interfacer keeps only what still resolves. The two begin identically and diverge entirely in whether anything was checked.

Seeding is what makes forking affordable: discovery stops being "find the flow" and becomes "confirm this flow and repair the differences," which is the work the arithmetic above assumes.

### the arithmetic

Hundreds of tenants times twenty applications times several capabilities is a large number of projects, and the spectrum above is what stops it being the product of all three. Only structural variants fork, and a structural variant is usually a vendor release rather than an institution — so the count tends toward capabilities × releases, not capabilities × tenants.

Where it does fork, a project is cheap: discovery costs dollars and minutes rather than engineer-days, which is the sense in which re-recording beats maintaining an override layer. It is not free, which is why it has a budget.

## testing

Almost everything this design claims is testable without a model, and most of it without a browser. The suite is shaped accordingly.

Two rules run through all of it. **Prefer fakes to mocks** — the claims here are properties of what a run actually produces, and a mock can assert that a call was made but not that a secret never appeared in the output. The deeper reason is that this design deliberately has few seams: no `Driver` interface, no provider registry, no plugin mechanism. Those are exactly where mocks attach, so a mock-heavy suite would generate pressure to reintroduce the abstractions "non-goals" rejects, purely for testability. And **integration tests drive the engine, not Playwright**: a test authors a `Flow` by hand and calls `.run()`, never `page.click()`. Otherwise the suite tests Playwright's behaviour rather than the verification order, retry gating, allowlist enforcement and record emission that only happen inside the engine's step cycle.

### unit

No browser, no app. This covers what is genuinely pure: `Secret` redaction through interpolation and `JSON.stringify`, allowlist matching against resolved URLs, cost accounting from `usage`, run-record entry construction, and `fields`/`Infer` as type-level tests.

One design pressure is worth accepting to widen this tier: the **verification order should be factored as a pure function** over the checkpoint result, the detector results and whether recovery applies. It is the most important algorithm in the engine, and that shape makes it exhaustively testable instead of reachable only through a browser.

### fixtures

Where there is an application there is a **fixture: a real HTTP app in the repo**, served, with sessions and redirects. Not a public site — that removes terms-of-service questions, rate limits and somebody else's outage from the suite — and not a stubbed page object, because the rules the engine implements are about navigation, resolved URLs after redirect, session expiry and multi-page flow, none of which exist without a server.

There are several, differing in how hostile they are, because a single clean app would never exercise the targeting chain:

| fixture | shape | exercises |
| --- | --- | --- |
| clean | semantic markup, roles, labels, test IDs | `byRole` wins throughout; the preferred strategies are genuinely preferred |
| legacy | server-rendered, table layout, no test IDs | the chain falling through to `text` and `css` |
| hostile | framesets, nested tables, generated class names, accessible names that differ from visible text, duplicate labels | ambiguity handling, and the honest floor where only `css` is left |
| rebranded | one of the above, restyled and reworded, same structure | the multi-tenant claim: the *same recorded flow* replays unchanged |
| skewed | one of the above, a screen split in two | the fork line, and variant-stamp diagnosis |

The rebranded fixture is the one that earns its keep beyond locator difficulty: it turns "semantic targeting is branding-invariant" from an assertion into a test.

Each fixture serves a login, a search, a detail screen and a multi-field action with a confirmation step, and each can be asked to produce every exceptional condition on demand — record not found, permission denied, session expired, an unexpected dialog, a slow load, an application error. Its data is fixed and its behaviour does not depend on the clock, because replay determinism cannot be tested against a moving target.

### integration

Real browser, real fixture, no model. This is where the production path is proved:

* **Determinism.** Replay one flow with the same inputs N times; assert the same steps, the same resolutions, the same result.
* **Verification order.** Drive a fixture into each declared outcome and assert the outcome is returned, not thrown. Then remove the detector and assert the same state produces a hard failure. The pair is what proves the ordering rather than assuming it.
* **Targeting.** Point the same flow at the rebranded fixture and assert it still passes. Break the primary strategy and assert the fallback carries it *and* that the drift is recorded. Make a target ambiguous and assert a hard failure rather than a silent first match.
* **Retry gating.** Fail a step transiently and assert a retry; fail a `.commit()` and assert none.
* **Allowlist.** Have a fixture redirect off-list and assert a hard failure on the resolved URL.
* **Pauses.** A fake resolver answers each of the four kinds; a second one never answers, so bound expiry is testable.
* **Redaction**, as a property rather than an example: run with a known secret sentinel and assert it appears nowhere in the record, in any attachment or in any thrown error — scanning all output, not checking a field.

### the agent loop

Real browser, real fixture, **fake model provider**: a scripted `decide(state, tools)` returning predetermined tool calls. This tests Interfacer's loop rather than the model — step appending, cost accounting, stall detection, budget exhaustion, and the allowlist check between turns.

It is also the only practical way to test pathological behaviour, because a live model will not produce it on demand: a provider that loops forever, or one that proposes a navigation off the allowlist, which is how the prompt-injection backstop gets exercised at all.

The `decide(state, tools)` seam pays for itself twice here — it exists for provider portability, and it happens to be exactly where a fake belongs, so no testing-only abstraction is introduced. It stays a fake only while tests assert on outcomes; a test asserting that `decide` was called twice with particular arguments is a mock wearing a fake's clothes.

### end to end

Real browser, real fixture, **live model**. Discovery reaches the goal, emits a project that compiles, and that project replays without a model — which is the through-line, and the only test that exercises the whole system. Also: a declared outcome is provoked during discovery and a detector recorded rather than reported unverified.

These are slow, non-deterministic and cost money, so they run before a release or on demand, never on every commit.

## non-goals

Two kinds of thing are absent here, and the difference matters to whoever builds this. Some are **deferred**: a seam exists and adding them later is additive. Others are **rejected**: adding them would cost a property the rest of the design depends on, and an implementer who helpfully supplies one has broken something.

### deferred

* **Desktop and other surfaces.** Browsers only. The seam is that a target names its own strategy, so a strategy resolving against an OS accessibility tree is additive — but there is no `Driver` interface to implement against, and building one before a second surface exists would be speculative.
* **A capability catalog and router.** A project exposes one capability. Mapping a tenant, or a name, to the right project is routing and sits above a single project; `variant` is declared so that a router can key on it.
* **Enforcement for `scope`, `external` and `financial`.** Declared in the contract, not enforced. Each needs machinery nothing else here uses: a runtime counter, an approval path identical to `reversible: no`, an amount check before the commit.
* **An operator console.** When a flow pauses for an operator the browser is already headed, so the human uses that window and signals resume. There is no co-browsing surface, no session sharing and no remote takeover.
* **Resuming a parked run after a crash.** A live browser cannot be restored mid-flow, so recovery is re-execution from step 0 with restored storage state. Parked runs die with their process.
* **Reconstructing an interview file from a project.** Interfacer never writes one back as a side effect of a run — a stored prose copy of the contract would drift the moment somebody edited the flow. But an explicit flag that points it at an existing project, emits a best-effort interview file from the declarations and exits is a reasonable convenience, because it derives rather than duplicates and saves hand-writing one to launch an unattended run elsewhere. The output is a draft to be edited: the budget and the target host are the two things the code does not know.

* **Publishing `@interfacer/dsl` to a registry.** A generated project has to run from wherever somebody puts it, and an unpublished dependency can only be named as a path back into an Interfacer checkout — a project that works where it was made and nowhere else. So generation copies the **built** package into the project and depends on that copy. The build rather than the source: what a capability may do is bounded by what the DSL offers, and source compiled by the project would put the allowlist check and the redaction rules one edit away from an owner who never meant to weaken them. It bounds where the *DSL* comes from and claims nothing about the rest of the graph — the project's own install still fetches Playwright from a registry, exactly as an install of a published DSL would have. The cost is worth naming rather than discovering: a fix in the DSL reaches an existing capability only by regenerating it, which lands hardest on the redaction, allowlist and effects rules, since those live in the DSL. It is deferred rather than rejected because publishing changes one line of a generated `package.json` and deletes a directory — the projects already emitted go on working, and the ones emitted afterwards name a version instead.
### rejected

* **A serialized artifact.** No manifest, no step file, no exported description. The program is the artifact, and a normalized copy of the same facts would be free to drift from the code it claims to describe.
* **General branching in the DSL.** A flow is a statically enumerable sequence, which is what lets the replay allowlist be computed from it and a step id mean the same thing on every run. Genuinely divergent tasks are two capabilities.
* **The model authoring TypeScript.** It calls tools and Interfacer emits the source. Letting it write code directly would put arbitrary TypeScript in the one place the design needs bounded.
* **Coordinates as targets.** Vision can inform a decision and can never be a target; nothing durable is recordable from a coordinate.
* **Override layers across tenants.** A base flow with per-tenant patches is a flow with indirection, and reading one means reconstructing the effective sequence from a base plus a chain of patches.
* **A provider abstraction.** One module owns the SDK, and moving provider means rewriting that module. No registry, no lowest-common-denominator message format, no supporting two at once.
* **Merge-preserving project updates.** When Interfacer runs it is authoritative and rewrites what it must; git is what makes that safe.
* **Log infrastructure.** The run record is a log stream. Rotation, shipping and aggregation are whatever the operator already does with logs.
* **A model anywhere in the replay path**, including to recover a failed step. A bounded single-step recovery is conceivable and would still make the production path non-deterministic, which is the one thing replay sells.

### where this grows first

In order: enforcement for the three declared-only effect dimensions, since the declarations already exist and only the checks are missing; then a router over `variant`, since capabilities multiply faster than anything else here; then a second surface, which is where the targeting seam finally gets tested rather than merely asserted.
