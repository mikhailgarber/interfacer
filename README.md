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
live-model test tier, which is a deliberate stop rather than an omission. **A capability
can be commissioned in a conversation, discovered by a model driving the application,
written out as a complete Node project that builds and runs with nothing added, and
replayed from then on with no model in the loop — stopping to ask a human without losing
its place, bounded in what it may write down about what it saw, and refused where its
own declaration says it needs a human it never asks.**

Not built: the live-model tier. Everything below is proved against real browsers and
real applications with a *scripted* model, which is a deliberate stop before spending
money on a live one. [docs/testing.md](docs/testing.md) records the shape it will take.

Why any of it is the way it is belongs to the
[design requirements](docs/design-requirements.md), and the order it was built in to
the [implementation plan](docs/implementation-plan.md). What follows is only what
exists.

## features

### commissioning one

- **One command.** `npx interfacer <project-name> [--root <dir>] [--interview <path>]
  [--record <where>] [--attachments <dir>]`. The goal and the entry point are not
  arguments — a goal is a paragraph, and the interview has to interrogate it anyway.
- **A conversation, not a form.** A model asks; Interfacer decides what counts as an
  answer. Present, absent and "no business outcomes" are three different things, and a
  run never proceeds on a question nobody was asked.
- **Guardrails are confirmed, never self-recorded.** The allowlist and `securityEffect`
  are proposed and enter the contract only where a person accepted them — or where an
  interview file states them and the model quotes the sentence, checked against the
  file. An allowlist entry is a bare host, optionally `*.`-prefixed: a scheme, a port or
  a path is refused as it is written, since such a pattern is matched against a hostname
  and could never admit anything.
- **Unattended from prose.** `--interview <path>` takes the human out of the session; an
  insufficient file exits listing exactly which answers are missing.
- **A rerun is a delta.** Pointing Interfacer at a location that already holds a project
  reads that project's own declarations as the recorded answers, and asks only what is
  left — usually the goal and the entry point a new tenant changes.

### discovering it

- **The model drives the real application**, and a step becomes part of the artifact
  only if the application accepted it, so the flow cannot drift from what happened.
- **It sees the accessibility tree** — the vocabulary its targets are written in — plus
  what identifies the page's value-bearing elements. Targets that count to an element or
  lean on a generated class name are refused when proposed.
- **Live values are asked for, never stored.** They are held in memory for the run and
  written nowhere; the flow refers to inputs by accessor. A credential is not echoed to
  the screen and never reaches the model.
- **Outcome detectors are provoked on purpose.** Interfacer reaches each declared
  outcome deliberately, in a run of its own, and records the condition from the page
  that produced it — discovery takes the shortest path to the goal rather than
  detouring, because every step it records is replayed for the life of the capability.
  One that cannot be reached is reported unverified rather than guessed, and one whose
  state was reached but which nothing detected is captured on screen, since that is the
  detector a person now has to write by hand.
- **Bounded three ways** — a budget the harness enforces, a stall guard, and a turn
  bound — and the partial flow is written whichever stops it, so a re-run continues from
  there. That holds for a phase that fails *after* discovery too: provoking an outcome
  or reading the pages can throw, and the flow already proved is still written out.
- **It leaves evidence where you point it.** `--record` sends the run record to a file
  or the other stream; `--attachments <dir>` writes the screenshot and DOM snapshot a
  hard failure, a handover, the point of no return, or an outcome that was reached but
  not detected triggers, into a directory per run.
  Both are off by default, and what may be captured is still what the contract declared.
- **A turn that calls nothing is recovered from, not fatal.** A refused request, or any
  turn carrying no tool call, has nothing to perform and no result to report; the loop
  says so and asks for a call, rather than sending an empty message the provider rejects.
  A refusal is named and its category recorded — such a turn used to leave no trace at
  all — and refusals that persist end the run as `refused` rather than as a stall.
- **A rejected model request explains itself.** Where the provider refuses a request it
  names a message index and nothing else, so the failure carries the request's *shape* —
  role, block kinds and byte counts per message, no content — into the record. Setting
  `INTERFACER_DEBUG_PAYLOAD=<file>` also writes the whole request on such a failure, and
  the response beside it where a turn came back with nothing to act on; those files hold
  live values and page content, so they are opt-in and yours to delete.
- **A seeded run verifies rather than trusts.** A project copied to a new tenant has its
  steps re-performed; what still resolves is kept, what does not is re-discovered, and
  every outcome is provoked again.

### the capability it writes

- **A complete Node/TypeScript project.** `package.json` with a `bin`, tsconfig, the
  contract declarations, the flow as source, the master function, a CLI, an MCP server,
  a variant stamp and a README. It builds and runs with nothing added.
- **No model in the replay path**, and no API key: the generated project never loads an
  SDK. Its one dependency is the DSL, copied in as the **built** package under
  `vendor/interfacer-dsl/` so the project runs from wherever it is put — the reasoning,
  and the price, are in `packages/interfacer/src/generate/vendor.ts`.
- **Three equal surfaces, none wrapping another.** A command line that prints the answer
  as JSON, an ordinary typed function whose result union the compiler checks, and a
  stdio MCP server exposing one tool named for the capability.
- **Typed answers, typed failures.** Success and every declared business outcome are
  arms of one union; hard failures are thrown as `ReplayError` with the run id, and
  `isReplayError` types the catch.
- **One declaration, many readers.** The CLI flags, the MCP input schema and the
  generated documentation all read the same `fields()` value at run time.
- **Parameterized by construction.** The entry point is an ordinary input, so one
  artifact serves every tenant that differs only in where it lives.

### running it safely

- **Secrets stay secrets.** A `secret()` is refused on argv and read from the
  environment, omitted from the published MCP schema, redacted by default in strings and
  JSON, and revealed only inside a DSL primitive.
- **It can stop and ask.** `.pauseForInput()`, `.pauseForApproval()` and
  `.pauseForOperator()` reach a human through one resolver; every pause is bounded, an
  expired approval is a deny, and resume re-asserts the last checkpoint that passed.
- **A run with nowhere to ask parks** beside its live browser; `resume` is single-shot
  and a TTL kills the session, so a forgotten run cannot strand a process.
- **Declared effects are enforced.** An irreversible step demands an approval, and it
  authorizes the next step rather than the run; a `securityEffect` demands an attended
  session, and both are decided from the artifact before a browser opens.
- **Evidence is bounded by what it declared.** `dataClasses` decides what a run may
  capture — full, masked, or no pixels at all — masking happens at capture time,
  attachments happen on three triggers only, and the run record is JSON lines on stdout,
  stderr or a file.
- **Drift is reported, not absorbed.** A target resolved by a weaker strategy than the
  one recorded says so in the run record, and the variant stamp says what the artifact
  was built against.

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

`scratch/` at the repo root is git-ignored and lint-ignored, and is where a manual run
belongs — so the project Interfacer writes can be read in the editor without becoming a
diff, or failing the gate on a lint posture it was never emitted to. It needs
`API_KEY`; the tests never write there. `INTERFACER_DEBUG_PAYLOAD=<file>` is the other
environment variable a run reads: it dumps the whole model request when the provider
rejects one, for diagnosing a malformed request.

```sh
npx interfacer demo --root scratch \
  --record scratch/demo-run.jsonl \
  --attachments scratch/demo-evidence
```
