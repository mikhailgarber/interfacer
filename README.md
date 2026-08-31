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
| `packages/dsl` | `@interfacer/dsl` — step vocabulary, `Target`, contract declarations, `Secret`, the execution engine, and the pause/resume machinery. The only runtime dependency a generated capability has. |
| `packages/interfacer` | `interfacer` — the CLI and agent: interview, agent loop, generation. It writes capability projects. |
| `fixtures` | Five real HTTP applications served from the repo — `clean`, `legacy`, `hostile`, `rebranded`, `skewed` — differing in how hostile they are. Everything above the unit tier is proved against these rather than a public site. `npm run fixtures` starts them for a person to look at. |
| `e2e` | The live-model tier. Tests only. |

Dependencies run one way. The DSL package knows nothing about Interfacer, the agent
loop, or any model, so a capability in production never loads an SDK and never needs
an API key.

## status

Phase 4 of the implementation plan. **A capability can be replayed, and can stop to
ask a human without losing its place.**

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

Not built yet: attachments and `dataClasses` (Phase 5), effect enforcement (Phase 6),
the project generator (Phase 7), and the agent loop (Phase 8).

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
