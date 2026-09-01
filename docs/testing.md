# testing

How the suite is organised, what each tier is allowed to assume, and — just as
importantly — what the runner config does *not* decide.

The shape follows the design's testing section: almost everything Interfacer
claims is testable without a model, and most of it without a browser, so the
tiers are ordered by what they are permitted to reach for.

## the tiers

| tier          | browser | app     | model    | invoked by           |
| ------------- | ------- | ------- | -------- | -------------------- |
| `unit`        | no      | no      | no       | `npm test`           |
| `fixtures`    | no      | HTTP    | no       | `npm test`           |
| `integration` | yes     | fixture | no       | `npm test`           |
| `agent`       | yes     | fixture | scripted | `npm test`           |
| `e2e`         | yes     | fixture | live     | `npm run test:e2e`   |

`npm test` runs the first four. **What keeps a tier out of the gate is a live model,
not a browser or a fixture.** A scripted `decide` is as deterministic and as free as a
hand-written flow, so the agent tier gates on the same terms as `integration` — and it
holds nine of the design's claims, which would otherwise be reported as covered by
tests the gate never ran. Only `e2e` is invoked explicitly: it is slow,
non-deterministic, and it costs money.

- **`unit`** — no browser, no app. What is genuinely pure: `Secret` redaction,
  allowlist matching against resolved URLs, cost accounting from `usage`,
  run-record entry construction. Type-level tests (`*.test-d.ts`) run here too,
  because `fields()`, `Infer` and `AnswerOf` are claims about types and the
  compiler is the only thing that can check them.
- **`fixtures`** — the fixture applications asserted at the HTTP level, with no
  engine and no browser: routes, redirects, session expiry, and every exceptional
  condition on demand. See **the fixtures** below.
- **`integration`** — real browser, real fixture, no model. This is where the
  production path is proved: determinism, verification order, targeting and
  fallback drift, retry gating, allowlist enforcement, pauses and parked runs,
  and the evidence rules — what `dataClasses` permits a run to capture, which
  three triggers produce attachments, and a sentinel scan over everything the run
  wrote. Tests author a `Flow` (see `packages/dsl/test/flows.ts`) and hand it
  to the engine. The resolvers the pause tests use are **fakes** — real functions
  answering the way a CLI's keyboard reader or a host's policy would, asserted on
  what the run produced rather than on how often they were called.
  It is by far the slowest tier that runs on every `verify` — around 65 seconds,
  most of it spent waiting out targets that are genuinely absent, which is the
  cost of the tests that prove a failure fails.
- **`agent`** — real browser, real fixture, scripted `decide(state, tools)`. Tests
  Interfacer's loop rather than the model: step appending, cost accounting, stall
  detection, budget exhaustion, and the between-turns allowlist check. It is also
  the only practical way to test pathological behaviour, because a live model will
  not produce it on demand — a provider that never finishes, or one that follows an
  instruction it read on a page. The scripted `decide` is a fake: it returns
  predetermined tool calls, and nothing asserts how it was called. It adds about six
  seconds to the gate, against `integration`'s sixty-five.

  It is also the tier that reads the **observation format** against more than one
  app. The design gives three reasons for showing the model an accessibility tree,
  and each needs a different fixture to see: `clean` shows the first — a tree that
  reads `button "Sign in"` is why a model proposes `byRole('button', 'Sign in')`.
  `legacy` shows the second, that a poor tree is still a tree: no `<label for>`, so
  the textboxes arrive unnamed and the field names as text beside them, and the
  whole thing is a third the size of the markup behind it. `hostile` shows what a
  picture could not — its sign-in button reads `Sign in` and is announced as
  `Submit credentials`, so the tree is the only observation in which the name that
  resolves is visible at all.
- **`e2e`** — real browser, real fixture, live model. The through-line: discovery
  reaches the goal, emits a project that compiles, and that project replays with
  no model attached. Slow, non-deterministic, and it costs money.

## the fixtures

Five real HTTP apps in `fixtures/`, differing in how hostile they are, because a
single clean app would never exercise the targeting chain. Not a public site — that
removes terms-of-service questions, rate limits and somebody else's outage from the
suite — and not a stubbed page object, because the rules the engine implements are
about navigation, resolved URLs after redirect, session expiry and multi-page flow,
none of which exist without a server.

| fixture     | shape                                                             | exercises                                                     |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `clean`     | semantic markup, roles, labels, test IDs                          | `byRole` wins throughout; the preferred strategies really are  |
| `legacy`    | server-rendered, table layout, no test IDs, no `<label>`          | the chain falling through to `text` and `css`                  |
| `hostile`   | nested tables, generated classes, mismatched names, duplicate labels | ambiguity handling, and the honest floor                    |
| `rebranded` | `clean` restyled and reworded, same structure                     | the multi-tenant claim: the same flow replays unchanged        |
| `skewed`    | `clean` with the detail screen split in two                       | the fork line, and variant-stamp diagnosis                     |

All five are one application rendered differently. That is what makes two of the
design's claims checkable rather than asserted: `rebranded` can be *proved* to
preserve `clean`'s structure, and `skewed` can be proved to diverge. `rebranded` is
written as its own module rather than as `clean` with a theme argument, so that
comparison is a real check and not two calls to the same function agreeing.

Each serves a login, a search, a detail screen and a multi-field action with a
confirmation step. Data is fixed and behaviour does not depend on the clock, because
replay determinism cannot be tested against a moving target — no timestamp, nonce or
CSRF token reaches a page, and money is formatted by hand rather than through `Intl`,
whose output varies with the ICU data built into the running Node.

**Exceptional conditions on demand.** A missing record (`ACC-9999`) and an
insufficient role (a `VIEWER` reading `ACC-2002`) fall out of the data. The rest are
asked for with a query parameter on the request that should exhibit them —
`?_fx=slow&_ms=800`, `?_fx=dialog`, `?_fx=session-expired`, `?_fx=app-error`. A
parameter rather than a control endpoint, because an endpoint that arms "the next
request" is shared mutable state and these run in parallel workers.

**The off-allowlist redirect.** `/offsite` redirects to a second server bound on the
same loopback interface but advertised as `localhost` rather than `127.0.0.1`. Those
are the same interface and two different *hosts*, which is the unit the allowlist
works in — so a navigation can genuinely leave the list without depending on DNS.

### looking at them

```sh
npm run fixtures                 # all five, plus the offsite host
npm run fixtures -- hostile      # just one
npm run fixtures -- --port 4100  # from a different base port
```

Prints a URL per fixture and holds until interrupted. Sign in with `teller1` /
`s3cret-teller` (a `TELLER`) or `viewer1` / `s3cret-viewer` (a `VIEWER`).

This is not a convenience. How tractable each app is — what `byRole` finds, where the
accessibility tree gives out, whether a screen reads as genuinely hostile — is a
judgement someone has to make by looking, and it is how `hostile` gets to be hostile
rather than hostile-by-assertion. Later phases inherit it: it is what a person uses to
sanity-check a target chain the model proposed, or to see the screen a failing replay
was looking at.

## the two standing rules

**Prefer fakes to mocks.** The claims here are properties of what a run actually
produces, and a mock can assert that a call was made but not that a secret never
appeared in the output. The deeper reason is that this design deliberately has few
seams — no `Driver` interface, no provider registry, no plugin mechanism — and
those are exactly where mocks attach. A mock-heavy suite would generate pressure
to reintroduce the abstractions the design rejects, purely for testability.

**Integration tests drive the engine, not Playwright.** A test authors a `Flow` by
hand and calls `.run()`; it never calls `page.click()`. Otherwise the suite tests
Playwright's behaviour rather than the verification order, retry gating, allowlist
enforcement and record emission that only happen inside the engine's step cycle.

The one current exception is `packages/dsl/test/browser.integration.test.ts`,
which touches a Playwright `Page` directly to prove the browser toolchain is
installed and drivable. From Phase 3 on it is the last test allowed to.

`pause.integration.test.ts` launches a browser of its own for the parked-run TTL
test and then asserts on `browser.contexts()`. That is not the exception wearing
a disguise: it drives nothing, and the browser's lifecycle is the claim under
test — a forgotten session must not strand a process, and the only honest way to
show a session was killed is to hold the handle it was killed on.

## where tests live, and what enforces it

A test's tier is its **filename suffix**, not its directory:

```
<name>.unit.test.ts   <name>.fixtures.test.ts   <name>.integration.test.ts
<name>.agent.test.ts  <name>.e2e.test.ts        <name>.test-d.ts
```

Test files live under one of four roots:

```
test/                 repo-wide tests that belong to no single package
packages/*/test/
fixtures/test/
e2e/test/
```

Tier and location are independent — any root may hold any tier. The tiers cut
across packages (`@interfacer/dsl` has unit and integration tests, `interfacer`
has unit and agent-loop tests), so tying a tier to a directory would fight the
layout and silently drop a correctly-named test filed in the "wrong" place.

Both lists are declared once, in `test/tiers.ts`. `vitest.config.ts` reads it to
build its projects and `test/suite.unit.test.ts` reads it to check the suite's own
shape. A second copy would be free to drift, and what it would drift into is a
tier that silently runs nothing.

### the orphan guard

`test/suite.unit.test.ts` exists because a suffix is a convention and nothing in
the runner objects to a test file that matches no tier. Such a file is never
collected, so a failing assertion inside it reports as a clean run — the one
failure mode a suite cannot catch by testing harder, because the evidence of it is
an absence.

It asserts that every test file sits under a known root, that every runtime test
file claims exactly one tier, and that no tier matches zero files. A tier whose
glob matches nothing passes loudly and meaninglessly, which is the same problem
wearing a different hat.

## running it

```sh
npm ci
npm run setup:browsers    # Chromium, for the integration tier and above
npm run verify            # build -> typecheck -> lint -> format:check -> test -> claims
```

`npm run verify` is the gate. There is no CI; adding a pipeline later would change
nothing about what it runs.

It ends with the design-claim report in its `--summary` form — the by-phase tally
only, since a hundred lines of per-claim listing would bury the gate's own output.
`npm run claims` prints the full listing. That last step is a **report, not a
threshold** — it fails
only on a marker the parser cannot read, and never on an uncovered claim, for the
reason given under *design-claim coverage* below. The guards that do gate — a
`@covers` naming a claim that no longer exists, a duplicate id — run in the test tier
before it.

Individual tiers: `npm run test:unit`, `test:fixtures`, `test:integration`,
`test:agent`, `test:e2e`. `npm run fixtures` starts the fixture apps for a person to
look at.

The steps `verify` chains are also runnable alone — `npm run build`, `typecheck`,
`lint`, `format:check`, `claims` — and `npm run format` writes the formatting that
`format:check` only reports on.

**Build before test.** Tests import `@interfacer/dsl` and `@interfacer/fixtures`
through the workspace symlink and each package's `exports` map into `dist/` — the
same path a generated capability takes, which is the point. The cost is that a stale
or missing build makes tests fail confusingly. `npm run verify` orders it correctly;
running `vitest` directly does not, and nothing in the runner config enforces it.

**The editor resolves through `dist/` too**, which is the same constraint wearing a
different hat. A fresh checkout opened before `npm run build` shows every
cross-package import as unresolved, and adding an export to a package leaves the
editor a build behind until one runs. Two mitigations:

```sh
npm run watch    # tsc --build --watch: keeps dist current while you edit
```

and, when a stale error persists after a build, restarting the TypeScript and ESLint
servers — the language server caches a failed module resolution and does not retry it
on its own. A diagnostic that `npm run lint` does not reproduce is that cache, not the
code.

**The phase-7 integration test builds a real project, outside the source tree.**
`packages/interfacer/test/generate.integration.test.ts` generates two capability
projects into a `mkdtemp` directory under the system temp root, runs `npm install` and
the project's own `tsc` in each, then imports the compiled master function, spawns the
CLI as a child process and speaks JSON-RPC to the MCP server — all against the `clean`
fixture. Asserting on the emitted *source* would prove only that the printer prints;
the artifact is a program, so the test compiles it and calls it.

Outside the source tree on purpose. A project that only builds where it was made is
not portable, and one built inside this repo would resolve the DSL, Playwright and
even TypeScript by walking up into the workspace — proving a portability it had
quietly arranged. Everything comes from the project's own `node_modules`, installed
from its own `package.json`, including the `tsc` that compiles it.

The cost is that this one test does a real install: `typescript`, `@types/node` and
Playwright, so it needs the network, and the first run pays for the download. It is
also why nothing needs to be ignored — no generated file ever lands in the repo.

**Fixture servers are started per test file, on ephemeral ports**, in a `beforeAll`
and closed in an `afterAll`. Not a `globalSetup`: files run in parallel workers, and
per-file servers on OS-assigned ports cannot collide on a port or share a session
store with each other — or with a fixture somebody has open in a browser.

**Coverage is collected from `dist/` and reported against `src/`.** That looks
wrong and is not: tests import each package through its `exports` map, so `dist/`
is what executes. Pointing `include` at `src/` finds the files and attributes
nothing to them — naming the emitted JavaScript is what makes the provider read
the emitted source maps, which puts the counts back on the TypeScript they came
from. A stale build therefore measures stale code.

**Retries are pinned to zero** in `vitest.config.ts`, not left to a default. Phase
3 asserts that replaying one flow N times produces the same steps, the same
resolutions and the same result; a retry would mask exactly the nondeterminism
that test exists to catch. Raising it is a design decision, not a flake remedy.

## coverage

Two reports, answering different questions.

### line coverage

```sh
npm run coverage    # the four free tiers, with a report
```

Reports land in `coverage/` (gitignored): a terminal summary, a browsable
`index.html`, and `lcov.info` for tooling. The e2e tier is left out because it
costs money to run.

Two files are excluded. `fixtures/src/serve.ts` is exercised by
`serve.fixtures.test.ts`, which spawns it as a child process — v8 coverage in this
process cannot see another one, so it is tested but unmeasurable from here.
`packages/interfacer/src/cli.ts` is a not-implemented stub until Phase 9.

### design-claim coverage

```sh
npm run claims              # the full listing
npm run claims -- --summary # the by-phase tally only; what `npm run verify` runs
```

Line coverage says whether code ran. It cannot say whether the suite verifies what
the design claims — a module can sit at 100% and prove nothing, and the properties
this design turns on are claims about behaviour.

**The design document is the registry.** Where
[design-requirements.md](design-requirements.md) makes a statement a test could
falsify, that statement carries a marker naming the claim and the plan phase that
should verify it:

```md
Every DSL call carries a stable step id, so errors and evidence refer to
`login.submit` rather than to a position that shifts whenever the flow is
edited. <!-- claim: artifact.stable-step-ids phase:3 -->
```

Tests declare what they exercise with a `@covers <id>` comment, and `test/claims.ts`
reads the document, joins the two, and reports:

```
  durable artifact
    · artifact.no-serialized-form              phase 7   docs/design-requirements.md:41
    ✓ artifact.stable-step-ids                 phase 3   docs/design-requirements.md:43
        packages/dsl/test/engine.integration.test.ts
```

Each claim carries the phase that should verify it, so the report distinguishes a
claim that is **pending** from one that is a **gap**. An uncovered claim from a
phase already delivered is the number worth looking at; one from a later phase is
simply not built yet.

**Nothing about a claim is restated in code.** The section is the heading the marker
sits under, the order is the document's, and the text is the statement the marker
terminates — so none of them is a field that can drift. This replaces a hand-written
registry that restated 90 claims in `test/claims.ts`; by the time it was retired, 87
of the 90 no longer matched the design's words, four cited a heading that did not
exist, and three architectural rejections were filed against a phase that had no way
to test them.

**Placing a marker.** Put it inline at the end of the statement it marks, never on
its own line — a comment between list items terminates the list, and cannot sit in a
table cell at all. The document is unwrapped, one paragraph per line, so a paragraph
making two claims carries two markers and each claim runs from the previous marker.
Place it after the sentence that states the claim, not at the end of the paragraph,
so trailing rationale stays out of it.

**What earns one.** A marker is a commitment that a test will exist, so a statement
earns one if a test could falsify it at some phase. Rationale, comparisons, and
restatements of a claim made canonically elsewhere do not; neither do positions that
no assertion can catch. A rejection is marked at the phase where the rejected thing
could actually be built — `artifact.no-serialized-form` is phase 7, because
generation is the only place a manifest could get written.

`claims.unit.test.ts` keeps the join honest at both ends. It fails on a `@covers`
naming an id no marker declares, so renaming or dropping a claim cannot leave a test
quietly asserting coverage of nothing; and it fails on a marker the parser cannot
read, which is the more important half — a mistyped title still renders as a
perfectly ordinary superscript, so nothing about the document would look wrong while
the claim quietly vanished from the report. It deliberately does **not** fail
on an uncovered claim: most of the design is unbuilt, and a gate that went red for
unwritten phases would be switched off within a week.

What it still cannot check is whether a statement that deserves a marker has one.
That judgement is a human reading the design — but the reading is now against the
document itself rather than against a paraphrase of it.

## not yet decided

The runner config is the tier/location mapping and timeouts. These are real
decisions that nothing has made yet, listed here so they are not mistaken for
settled:

- **Frame traversal** — `hostile` serves a help panel inside an `<iframe>`, and
  the design says nothing about whether the engine resolves a target across a
  document boundary. The frame is deliberately off the critical path, so every
  flow completes without entering it and Phase 3 is not forced to decide. It
  becomes a real question the first time a capability needs something that only
  exists inside a frame. *(Phase 3, if then)*
- **Headed vs headless for `e2e`** — mostly settled. Replay is headless by
  default; `discover()` is headed by default, so an operator pause hands over a
  window that is already open, and a generated CLI runs headed where the flow
  declares one or the effects require an attended session. Phase 6 found the
  limit: Playwright exposes no way to ask a `Browser` how it was launched, so the
  check reads the `headless` option and a caller supplying its own browser is
  taken at its word — which is what the `agent` tier does, since it is testing
  the loop rather than the window. What a live-model `e2e` run should use, and
  how a person overrides it locally to watch one, is the part still open.
  *(Phase 10)*
- **Run-record capture** — the record goes to stdout by default. Phase 3's
  redaction test asserts a secret sentinel appears nowhere in the record, in any
  attachment, or in any thrown error — scanning all output, not checking a field.
  That needs a capture policy. *(Phase 3)*
- **Spend guard for `e2e`** — the tier currently skips when `API_KEY` is absent.
  Skipping is right for a scaffold and wrong for a release gate, which should say
  it could not run rather than report green. *(Phase 10)*
