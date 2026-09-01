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
| `packages/interfacer` | `interfacer` — the CLI and agent: interview, agent loop, generation. It writes capability projects; the generator and the discovery loop are the parts that exist. |
| `fixtures` | Five real HTTP applications served from the repo — `clean`, `legacy`, `hostile`, `rebranded`, `skewed` — differing in how hostile they are. Everything above the unit tier is proved against these rather than a public site. `npm run fixtures` starts them for a person to look at. |
| `e2e` | The live-model tier. Tests only. |

Dependencies run one way. The DSL package knows nothing about Interfacer, the agent
loop, or any model, so a capability in production never loads an SDK and never needs
an API key.

## status

Phase 8 of the implementation plan. **A capability can be replayed, can stop to ask a
human without losing its place, is bounded in what it may write down about what it
saw, is refused where its own declaration says it needs a human it never asks, can be
written out as a complete Node project that builds and runs with nothing added — and
can be discovered by a model driving the same engine that replays it.**

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

Every SDK call lives behind one `decide(state, tools)` function and nothing else
imports the SDK, which a test checks by reading the source rather than by watching a
call. `API_KEY` and `MODEL` come from the environment and are checked before a browser
opens. A run ends when `returns` is verified, or when one of three bounds stops it: the
budget — told to the model as a ceiling and enforced by the harness, which is the only
one of the two that is a control — the stall guard, and a bound on turns for a provider
that costs nothing and never finishes. The partial flow survives all of them.

Not built yet: the interview (Phase 9) and generation mode (Phase 10).

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
