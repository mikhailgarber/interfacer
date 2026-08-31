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
| `packages/dsl` | `@interfacer/dsl` — step vocabulary, `Target`, contract declarations, `Secret`, and the execution engine. The only runtime dependency a generated capability has. |
| `packages/interfacer` | `interfacer` — the CLI and agent: interview, agent loop, generation. It writes capability projects. |
| `fixtures` | Real HTTP applications served from the repo, differing in how hostile they are. Everything above the unit tier is proved against these rather than a public site. |
| `e2e` | The live-model tier. Tests only. |

Dependencies run one way. The DSL package knows nothing about Interfacer, the agent
loop, or any model, so a capability in production never loads an SDK and never needs
an API key.

## status

Phase 1 of the implementation plan. `@interfacer/dsl` carries the contract and the
pure primitives — `Secret`, `fields()`/`Infer`, `Target`, the allowlist matcher, cost
accounting, run-record entry construction, and the verification-order function. The
`Flow` builder, the execution engine, the fixtures and the agent loop are not built
yet.

## working on it

```sh
npm ci
npm run setup:browsers    # Chromium, for the integration tier and above
npm run verify            # build -> typecheck -> lint -> format:check -> test
```

`npm run verify` is the gate. See [docs/testing.md](docs/testing.md) for the tiers
and how to run them individually.
