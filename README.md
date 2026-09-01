# interfacer

Many applications offer no API: the only way in is to drive the UI the way a human
operator does. An AI agent that needs to work inside one has no way to reach it.

Interfacer gives it one. Given a task described in English and an entry point, it
produces a **capability** — a typed, versioned, parameterized function an agent can
call by name, which performs the task through the application's own interface with
no model in the loop.

> An LLM discovers the interface once. The discovery is captured as a program.
> Deterministic replay of that program is how agents invoke it from then on.

## documentation

- [Design requirements](docs/design-requirements.md) — what this is and why it is
  shaped the way it is. The authority; everything else follows from it.
- [Implementation plan](docs/implementation-plan.md) — the ordered build, in
  phases, each closed by a test tier.
- [Testing](docs/testing.md) — the five tiers, where tests live, what the runner
  config decides, and what it deliberately leaves open.
- [CLAUDE.md](CLAUDE.md) — conventions for working in this repo: which doc is the
  authority, the gate, and the rule that the docs above stay true.

## layout

| | what it is |
| --- | --- |
| `packages/dsl` | `@interfacer/dsl` — step vocabulary, `Target`, contract declarations, `Secret`, the execution engine, pause/resume, the evidence rules, and the effects a run refuses. The only runtime dependency a generated capability has. |
| `packages/interfacer` | `interfacer` — the CLI and agent: the interview that settles a contract, the discovery loop that finds the flow, and the generator that writes the project. |
| `fixtures` | Five real HTTP applications served from the repo — `clean`, `legacy`, `hostile`, `rebranded`, `skewed` — differing in how hostile they are. Everything above the unit tier is proved against these rather than a public site. `npm run fixtures` starts them for a person to look at. |
| `e2e` | The live-model tier. Tests only. |

Dependencies run one way. The DSL package knows nothing about Interfacer, the agent
loop, or any model, so a capability in production never loads an SDK and never needs
an API key.

## status

Phase 10 of the implementation plan — the last of them, and complete apart from the
live-model tier, which is a deliberate stop rather than an omission. **A capability can
be commissioned in a
conversation, discovered by a model driving the application, written out as a complete
Node project that builds and runs with nothing added, and replayed from then on with no
model in the loop — stopping to ask a human without losing its place, bounded in what it
may write down about what it saw, and refused where its own declaration says it needs a
human it never asks.**

`@interfacer/dsl` carries the contract and the pure primitives — `Secret`,
`fields()`/`Infer`, `Target`, the allowlist matcher, cost accounting, run-record entry
construction, and the verification-order function — plus the `Flow` builder and the
execution engine: target resolution through the strategy chain with drift reporting,
the recover/outcome/fail ladder, per-step retry gating, allowlist enforcement on the
resolved URL, the three endings, and the run record as JSON lines.

It also carries pause and resume. `.pauseUntil()` waits on a predicate with a bound,
never a sleep; `.pauseForInput()`, `.pauseForApproval()` and `.pauseForOperator()` ask
a human through one `Resolver`, and the engine validates the answer against the kind
it asked. Every pause is bounded — an approval that expires is a deny, and everything
else is a typed hard failure with evidence rather than a hang. A run with nowhere to
ask **parks**: it is held in memory beside its live browser, `resume(sessionId,
response)` is single-shot, and a TTL kills the session so a forgotten run cannot
strand a browser. Resume re-asserts the last checkpoint that passed, because a flow
may not assume where it is once a human has touched the session. The overloads say
this in the types: supply a `resolver` and the `suspended` arm does not exist; omit
one and it does.

`fixtures` carries the five applications everything above the unit tier is proved
against, each serving a login, a search, a detail screen and a multi-field action with
a confirmation step, and each able to produce every exceptional condition on demand.

And it carries the evidence rules. A capability declares `effects` — what it changes,
whether that is reversible, and the `dataClasses` it observes — and `dataClasses`
decides what a run may capture: a full screenshot and full markup for
non-identifying data, a masked screenshot and a values-stripped DOM for PII, and no
pixels at all for a full PAN or an SSN. Masking happens at capture time, so an
unredacted artifact never exists. Recorded URLs are bounded the same way, because an
application that puts a reference in a query string would otherwise write an observed
value straight into the record. Attachments happen on three triggers only — a hard
failure, a control transfer, and the `.commit()` — and only where a directory is
configured; where none is, the record says it skipped. `effect.performed` names the
declared dimension and links the `pause` that approved it, so *did anything
irreversible happen, and was it authorized* is answered by reading the record. The
record goes to stdout by default, or to stderr or a file — which is what an MCP entry
point must select, since stdout there is the protocol transport.

And it enforces the two `effects` dimensions the design says drive an enforcement.
`reversible: 'no'` demands an approval before the `.commit()`, and an approval
authorizes the step that follows rather than the run — a second irreversible action
asks a human a second time. A `securityEffect` other than `'none'` demands both an
approval and an attended session, so a run asked for headless is refused. Both are
decided from the artifact before a browser opens, because a flow that cannot satisfy
its own declaration is knowable from what was written down; the record still shows a
run that started and failed, since a refusal nobody can see in the record reads as a
run that never happened. `scope`, `external` and `financial` stay declared and
published rather than enforced, each needing machinery nothing else here uses.

`interfacer` carries the generator. Given a finished `Flow` and its contract it emits
a project: `package.json` with a `bin`, a tsconfig, the `inputFields` / `effects`
declarations, the flow itself as source, the master function and its overloads, a CLI
entry point, a stdio MCP server, `variant.ts`, and a README written from the same
declarations. Only the flow is genuinely synthesized; the two entry points are the
same source in every project, because they read the declarations at run time rather
than having a schema baked into them.

The three surfaces are equal, and none wraps another. **The command line** prints the
answer as JSON and exits 0 for a success and for a business outcome alike, sends a
hard failure to stderr with the run id, refuses a `secret()` on argv and takes it from
the environment, and answers its own pauses from the keyboard so the command stays one
blocking call — its run record goes to stderr, because stdout carries the answer. **As
a library** it is an ordinary typed function: `switch` on `result.status`,
`isReplayError` in the catch, and supplying a resolver removes the `suspended` arm from
the type. **As an MCP server** it speaks newline-delimited JSON-RPC over stdio with no
dependency beyond the DSL, exposes one tool named for the capability, publishes the
inputs without the credentials and the declared outcomes as the output schema, puts the
effects in the tool description, and returns `suspended` as an ordinary result with a
companion `resume` tool.

The project carries the engine rather than naming it. `@interfacer/dsl` is not
published to a registry, so a dependency on it would be a path back into an Interfacer
checkout — a project that only works where it was made. Generation copies the **built**
package into `vendor/interfacer-dsl/` and depends on that, so the project runs from
wherever it is put; its own `npm install` pulls Playwright exactly as an install from a
registry would have. The build rather than the source, because what a capability may do
is bounded by what the DSL offers and that bound is structural — source compiled by the
project would put the allowlist check and the redaction rules one edit away. The price
is stated plainly: a fix in the DSL reaches an existing capability only by regenerating
it.

Emitting source is what the described accessors are for. `field('username')`,
`obtained('mfaCode')`, `extracted('balance')`, `literal(…)`, `join(…)` and
`answer(status, values)` are the same functions the engine calls, carrying what they
read — a closure runs identically and cannot be printed back into source, so the
generator refuses one by name rather than emitting something that looks right. A
`read` capability containing a `.commit()` is refused here too, once, rather than at
every run.

And it carries the discovery loop. **There is one execution engine with two callers.**
`openExecution()` holds a live session and walks a flow a step at a time; `runFlow()`
is that loop run start to finish, and discovery is the same engine with a model
deciding what comes next. What worked during discovery is therefore a claim about
replay — the agent tier proves it by discovering a flow and then replaying the very
same object with nothing in the loop.

Interfacer owns the loop rather than delegating it, because four things happen between
turns and all of them are its responsibility: the allowlist is checked on any
navigation, the successful step is appended, the run record gets its entries, and spend
is accumulated against the budget. The model's tools are the DSL vocabulary, one tool
per verb, plus `snapshot`, `screenshot` and `ask`; calling one executes it and appends
the step **only if the application accepted it**, so the flow cannot drift from what
happened. Each turn the model is given the accessibility tree — the same vocabulary its
targets are written in — and a screenshot is a second tool that can never be a target.
`ask` reaches the person in the session in prose, on the same channel the interview
uses rather than the pause resolver a running capability answers on: a pause needs a
value of a known kind, and a question does not have one.

Every SDK call lives behind one `decide(state, tools)` function and nothing else
imports the SDK, which a test checks by reading the source rather than by watching a
call. `API_KEY` and `MODEL` come from the environment and are checked before a browser
opens. A run ends when `returns` is verified, or when one of three bounds stops it: the
budget — told to the model as a ceiling and enforced by the harness, which is the only
one of the two that is a control — the stall guard, and a bound on turns for a provider
that costs nothing and never finishes. The partial flow survives all of them.

And it carries the interview, which is where a capability is commissioned. `npx
interfacer <project-name> [--root <dir>] [--interview <path>]` resolves the location
first — creating it, treating an empty one as a new project, and treating an occupied
one as a project update — and checks `API_KEY` before any of it, so a missing key costs
a second rather than an entire interview. The goal and the entry point are deliberately
not arguments: a goal is a paragraph rather than a flag, and the interview has to
interrogate it anyway to get the contract out of it.

A model conducts the conversation; Interfacer decides what an answer is. An answer is
present, absent, or an empty list — "this task has no business outcomes" is something a
person said and "nobody asked yet" is not, and a run does not proceed on a question that
was never put. The two effects questions are asked, the remaining dimensions are
proposed, and **the allowlist and `securityEffect` are proposed rather than asked, so
they are the two answers a model could quietly settle for itself.** It cannot: a
guardrail enters the contract only where a person confirmed it in the conversation, or
where the interview file states it and the model quotes the sentence that does — checked
against the file, because a model that resolves its own constraints has not been
constrained.

`--interview <path>` supplies the answers as prose and takes the human out of the
session. There is then nobody to ask and nobody to confirm, so an insufficient file
exits listing exactly which answers are missing, and a proposal absent from the file is
one of them rather than a silent accept. An unattended run with no budget is missing an
answer like any other: there is no fallback, because a default nobody chose is not an
authorization. The file is an input only and is never written back — there would be
nothing to write that the project does not already hold, and a prose copy of the
contract would drift the moment somebody edited the flow by hand.

Which is also why a rerun is a delta rather than a repeat. The project's own
declarations are the recorded answers, read from its source rather than from a sidecar
or a build: `fields()`, `effects`, `interactions`, the confirmed allowlist, the outcomes
the flow declares and the shape it returns. What is left to ask is usually the goal and
the entry point a new tenant changes. Anything the reader cannot parse is absent rather
than guessed, so an edited project asks one question too many instead of carrying an
answer nobody gave.

And it carries generation mode, which is the same session going on. When the contract is
settled Interfacer switches to driving the model through the task against the live
application, and the conversation does not stop: the model asks for the live values it
needs as it needs them, naming the input each answer supplies, and they are held in
memory and written nowhere — the flow refers to inputs by accessor, so the artifact is
parameterized by construction. The point of no return is put to the person before it is
activated, because an approval that arrived after the fact would be authorizing
something already done.

Then the outcomes. The interview declared what the task can end in besides success, and
a detector for one is only findable by **reaching that state on purpose** — so Interfacer
drives a pass of its own: it has the model ask for a value that provokes the outcome,
re-runs the flow's own steps with it (performed, never appended — the flow is already
built), and lets the model name the condition on the page that results. The tool refuses
a detector that does not match what is in front of it. An outcome that cannot be reached
is **reported unverified**, never guessed: an arm in the contract whose condition never
matches arrives at replay as a hard failure, which is worse than not having it.

Then the project. The session walks the finished flow once more so the model is looking
at the screens rather than at a recollection of them, and proposes the two declarations
only the application can settle — `vendor` and `appVersion` for the variant stamp, and a
revision to `securityEffect` from what those screens gave up. Both are confirmed by the
person, on the same terms as the allowlist; a field nobody knows is left absent, because
a fabricated version reads as fact. A run that stops early — the stall guard, or a budget
nobody was there to raise — still writes what it found, marked partial, because a re-run
reads the project like any other and continues from those steps rather than starting
over. Interactively, reaching the ceiling is an approval rather than a failure.

And a rerun in a location that already holds a project starts from that project. Its
flow is read back out of its own source — the reader is the printer's pair, and the
round trip is asserted as one — and then **verified rather than trusted**: the steps are
performed against this application, the ones that still resolve are kept, and the run
picks up from the first that does not, which is retracted along with everything after
it. The outcome detectors are deliberately not carried across, because wording is
precisely what differs between tenants and a detector inherited unverified is the
failure the whole mechanism exists to prevent: they are provoked again or they are not
there. That is the difference between copying a project and editing the URL, which keeps
a sibling's steps unchecked, and copying it and running Interfacer, which keeps only what
still works. A call the reader cannot parse — a hand edit, most likely — stops the read
there, so the cost is re-discovering the part that was edited rather than a flow that is
quietly wrong.

Not built yet: the live-model tier. Everything above is proved against real browsers and
real applications with a scripted model, which is a deliberate stop before spending money
on a live one.

## working on it

```sh
npm ci
npm run setup:browsers    # Chromium, for the integration tier and above
npm run verify            # build -> typecheck -> lint -> format:check -> test -> claims

npm run coverage          # the tiers verify runs, with a line-coverage report
npm run claims            # which of the design's claims the suite verifies, in full
npm run fixtures          # start the fixture apps and print their URLs
npm run watch             # keep dist/ current while editing (the editor reads it)
```

`npm run verify` is the gate. See [docs/testing.md](docs/testing.md) for the tiers
and how to run them individually.
