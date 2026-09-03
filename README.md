# interfacer

Many applications offer no API: the only way in is to drive the UI the way a human
operator does. An AI agent that needs to work inside one has no way to reach it.

Interfacer gives it one. Given a task described in English and an entry point, it
produces a **capability** — a typed, versioned, parameterized function an agent can
call by name, which performs the task through the application's own interface with
no model in the loop.

> An LLM discovers the interface once. The discovery is captured as a program.
> Deterministic replay of that program is how agents invoke it from then on.

The model is in the loop exactly once, during discovery. What it produces is an
ordinary Node/TypeScript project — the recorded flow as source, a typed contract, a
CLI, a library entry point, and an MCP server — that builds and runs on its own and
never loads a model SDK again.

## what's built

### commissioning it — the interview

- **One command.** `npx interfacer <project-name>`. The goal is a paragraph and the
  entry point a URL — both come through a conversation, not flags.
- **A model conducts the interview; Interfacer decides what counts as an answer.** It
  settles a typed contract — inputs, outputs, business outcomes, effects, allowlist —
  and never proceeds on a question nobody was asked.
- **Guardrails are confirmed, never self-recorded.** The allowlist and
  `securityEffect` enter the contract only where a person accepted them, or where an
  interview file states them and the model quotes the sentence verbatim.
- **Unattended from prose.** `--interview <path>` takes a written brief instead of a
  person at the keyboard. If it doesn't answer everything the contract needs, the run
  stops before touching a browser and lists exactly which answers are missing.
- **A rerun is a delta.** Point it at an existing project and it reads that project's
  declarations as the recorded answers, asking only what a new tenant changes.

### discovering the flow — the agent loop

- **The model drives the real application** through Playwright, and a step joins the
  artifact only if the application accepted it — so the flow can't drift from what
  happened.
- **It works from the accessibility tree**, plus the identifying attributes of
  value-bearing elements — the same representation a desktop surface would expose, not
  a screenshot.
- **Brittle targets are refused when proposed.** Positional selectors, generated class
  names, and out-of-order fallback chains are rejected at authoring time.
- **It navigates by acting, not by addressing.** `open` accepts only an address the
  contract declares; a URL assembled from literals is refused.
- **Live values are asked for, never stored.** Held in memory for the run, written
  nowhere; a credential never reaches the model.
- **Outcome detectors are provoked on purpose.** Each declared outcome is reached in
  its own run and its detector recorded from the page that produced it. One that can't
  be reached is reported unverified, not guessed.
- **Seeded discovery.** A project copied to a new tenant re-performs its steps, keeps
  what still resolves, re-discovers what doesn't, and re-provokes every outcome.

### the capability it writes

- **A complete Node/TypeScript project** — `package.json` with a `bin`, tsconfig,
  contract, the flow as source, the master function, a CLI, an MCP server, a variant
  stamp, a README. Builds and runs with nothing added.
- **Because the artifact is a project, not a serialized document, it is code** —
  versioned in git, reviewed in a pull request, diffed when it changes, and
  hand-editable where discovery got something wrong.
- **No model in the replay path, and no API key.** The only dependency is the DSL,
  vendored in as the built package so the project runs from anywhere.
- **Three equal surfaces** — a CLI that prints JSON, a function that can be called as
  a library from a larger project, and a stdio MCP server exposing one tool named for
  the capability.
- **Typed answers, typed failures.** Success and every business outcome are arms of
  one union; hard failures throw `ReplayError` with the run id.
- **One declaration, many readers.** CLI flags, MCP input schema, and generated docs
  all read the same `fields()` value at runtime.
- **Parameterized by construction.** The entry point is an ordinary input, so one
  artifact serves every tenant that differs only in where it lives.

### replaying it safely

- **Deterministic replay.** Stable targeting with a fallback chain, checkpoints
  verified, declared outputs returned — no model in the decision loop.
- **An explicit error taxonomy.** Expected business outcomes, recoverable conditions,
  and hard failures are distinguished in the result contract; a hard failure names the
  step, what was expected, and what was observed.
- **Secrets stay secret.** Refused on argv, read from the environment, omitted from
  the MCP schema, redacted in strings and JSON, revealed only inside a DSL primitive.
- **It can stop and ask.** `.pauseForInput()`, `.pauseForApproval()`,
  `.pauseForOperator()` reach a human through one resolver; every pause is bounded,
  and resume re-asserts the last checkpoint that passed.
- **A run with nowhere to ask parks** beside its live browser; `resume` is single-shot
  and a TTL kills the session, so a forgotten run can't strand a process.
- **Declared effects are enforced** from the artifact before a browser opens: an
  irreversible step demands an approval that authorizes the next step only; a
  `securityEffect` demands an attended session.
- **Every run emits a structured record** — JSON lines of what it did and why — and on
  a hard failure, a handover, or an outcome reached but not detected, it saves a
  screenshot and DOM snapshot to an evidence directory.
- **`dataClasses` is a data-protection control.** It decides whether those captures
  are kept in full, masked, or not taken at all, and masking happens at capture time —
  regulated financial data never lands on disk unredacted.
- **Drift is reported, not absorbed.** A target resolved by a weaker strategy than the
  one recorded says so, and the variant stamp says what the artifact was built against.

## setup

```sh
npm ci
npm run setup:browsers    # Chromium — discovery and the browser tiers need it
```

Two environment variables, both read from the process environment, never from argv:

- `API_KEY` — an Anthropic API key. **Discovery only.** A generated capability never
  reads it.
- `MODEL` — optional, overrides the default discovery model.

**Running without live services:** replay needs neither. A generated capability drives
a browser against whatever URL you pass it and never calls a model, so the only thing
a replay needs is the target application reachable. `npm run fixtures` starts five
local stand-ins to replay against.

## the demo path

Discovery needs a target. Start the bundled fixtures in one terminal:

```sh
npm run fixtures          # prints a URL per fixture; `clean` is http://127.0.0.1:4001
```

**1. Discover** — a live model drives the task and writes the project. This is the one
step that needs `API_KEY`:

```sh
API_KEY=sk-... npx interfacer balance-lookup --root scratch \
  --record scratch/balance-lookup.jsonl \
  --attachments scratch/balance-lookup-evidence
```

It interviews you first (goal, entry point, inputs, outcomes), then drives `clean`
through the task. Answer the entry point with `http://127.0.0.1:4001`, sign-in as
`teller1` / `s3cret-teller`, and give it an account that exists (`ACC-1001`) and one
that does not (`ACC-9999`) when it provokes the outcomes. The project lands in
`scratch/balance-lookup/`.

**2. Build the capability** — plain `tsc`, no model:

```sh
cd scratch/balance-lookup && npm install && npm run build
```

**3. Replay it** — no `API_KEY`, no model in the loop. Exact flags come from what
discovery declared; `npx balance-lookup --help` prints them. For the capability above:

```sh
# success — returns the balance as JSON, exit 0
PASSWORD=s3cret-teller npx balance-lookup \
  --url http://127.0.0.1:4001 --username teller1 --account-number ACC-1001

# a business outcome — `account_not_found` as JSON, still exit 0 (it is an answer)
PASSWORD=s3cret-teller npx balance-lookup \
  --url http://127.0.0.1:4001 --username teller1 --account-number ACC-9999

# a hard failure — names the step, expected, observed; exit 1
PASSWORD=wrong npx balance-lookup \
  --url http://127.0.0.1:4001 --username teller1 --account-number ACC-1001
```

A captured end-to-end run — discovery record, the generated project, failure
attachments, and replays including a business outcome — is in
[`evidence/`](evidence/), with the exact commands that produced it.

## working on it

```sh
npm run verify            # build -> typecheck -> lint -> format:check -> test -> claims  (the gate)
npm run coverage          # the tiers verify runs, with a line-coverage report
npm run claims            # which of the design's claims the suite verifies, in full
npm run fixtures          # start the fixture apps and print their URLs
npm run watch             # keep dist/ current while editing (the editor reads it)
```

`npm run verify` is the gate, and GitHub Actions runs it inside the repository's Dev
Container on each push to `master`. Individual tiers: `npm run test:unit`,
`test:fixtures`, `test:integration`, `test:agent`.

Preferred from inside the VS Code devcontainer. The commands above should work
outside a devcontainer as-is, but may hit dependency or toolchain differences the
container pins down.

To run the same on the host without VS Code but still inside the devcontainer,
prefix each command with `./dev.sh` (it offers to install `@devcontainers/cli`,
then creates or reuses the container):

```sh
./dev.sh npm ci
./dev.sh npm run setup:browsers
./dev.sh npm run verify
```

`scratch/` at the repo root is git-ignored and lint-ignored: a manual run belongs
there, so the project Interfacer writes can be read in the editor without becoming a
diff. `INTERFACER_DEBUG_PAYLOAD=<file>` dumps the whole model request when the
provider rejects one, for diagnosing a malformed request.

## design claims

The design document is also the test registry. Where
[design-requirements.md](docs/design-requirements.md) makes a statement a test could
falsify — *a target resolved by a weaker strategy than the one recorded is reported
as drift* — that sentence carries an inline marker naming a claim id and the phase
meant to prove it. Tests tag themselves with a `@covers <id>` comment, and `npm run
claims` joins the two and reports which claims the suite actually verifies, by
phase. The claim *is* the sentence — reword it and the report changes, with no
second copy to drift. [docs/testing.md](docs/testing.md), *design-claim coverage*,
has the rationale.

## documentation

- [Design requirements](docs/design-requirements.md) — what this is and why it is
  shaped the way it is. The authority; everything else follows from it.
- [Implementation plan](docs/implementation-plan.md) — the ordered build, in phases,
  each closed by a test tier.
- [Testing](docs/testing.md) — the four tiers, where tests live, and how the live
  model is validated by hand rather than in the gate.
- [REPORT.md](REPORT.md) — the design write-up: architecture, artifact schema,
  determinism, heterogeneity, escalation, safety, and what was cut.
- [CLAUDE.md](CLAUDE.md) — conventions for working in this repo.

## layout

| | what it is |
| --- | --- |
| `packages/dsl` | `@interfacer/dsl` — step vocabulary, `Target`, contract declarations, `Secret`, the execution engine, pause/resume, the evidence rules, and the effects a run refuses. The only runtime dependency a generated capability has. |
| `packages/interfacer` | `interfacer` — the CLI and agent: the interview that settles a contract, the discovery loop that finds the flow, and the generator that writes the project. |
| `fixtures` | Five real HTTP applications served from the repo — `clean`, `legacy`, `hostile`, `rebranded`, `skewed` — differing in how hostile they are. Everything above the unit tier is proved against these rather than a public site. |
| `evidence` | A captured live-model run, end to end. |

Dependencies run one way. The DSL package knows nothing about Interfacer, the agent
loop, or any model, so a capability in production never loads an SDK and never needs
an API key.

## how the live model is checked

The automated suite proves everything above against real browsers and real
applications with a *scripted* model, and gates on every push. A live model driving
discovery end to end has no tier — it is slow, costs money per run, and its failures
are findings a person reads rather than builds a job bisects. It is validated by hand
instead, as AI-assisted sanity runs against the fixtures and occasionally a real
site; [docs/testing.md](docs/testing.md), "live-model validation", says how and why,
and [`evidence/`](evidence/) keeps one such run.
