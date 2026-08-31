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
| `agent`       | yes     | fixture | scripted | `npm run test:agent` |
| `e2e`         | yes     | fixture | live     | `npm run test:e2e`   |

`npm test` runs the first three — fast, deterministic and free. The last two cost
wall-clock or money and are invoked explicitly, so nothing sweeps them into the
default gate by accident.

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
  fallback drift, retry gating, allowlist enforcement, pauses, redaction.
- **`agent`** — real browser, real fixture, scripted `decide(state, tools)`. Tests
  Interfacer's loop rather than the model: step appending, cost accounting, stall
  detection, budget exhaustion, and the between-turns allowlist check. It is also
  the only practical way to test pathological behaviour, because a live model will
  not produce it on demand.
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
npm run verify            # build -> typecheck -> lint -> format:check -> test
```

`npm run verify` is the gate. There is no CI; adding a pipeline later would change
nothing about what it runs.

Individual tiers: `npm run test:unit`, `test:fixtures`, `test:integration`,
`test:agent`, `test:e2e`. `npm run fixtures` starts the fixture apps for a person to
look at.

The steps `verify` chains are also runnable alone — `npm run build`, `typecheck`,
`lint`, `format:check` — and `npm run format` writes the formatting that
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

**Fixture servers are started per test file, on ephemeral ports**, in a `beforeAll`
and closed in an `afterAll`. Not a `globalSetup`: files run in parallel workers, and
per-file servers on OS-assigned ports cannot collide on a port or share a session
store with each other — or with a fixture somebody has open in a browser.

**Retries are pinned to zero** in `vitest.config.ts`, not left to a default. Phase
3 asserts that replaying one flow N times produces the same steps, the same
resolutions and the same result; a retry would mask exactly the nondeterminism
that test exists to catch. Raising it is a design decision, not a flake remedy.

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
- **Headed vs headless** — replay is headless by default and discovery is headed
  so a human can watch. Which the `agent` and `e2e` tiers use, and how that is
  overridden locally, is undecided. *(Phase 8)*
- **Run-record capture** — the record goes to stdout by default. Phase 3's
  redaction test asserts a secret sentinel appears nowhere in the record, in any
  attachment, or in any thrown error — scanning all output, not checking a field.
  That needs a capture policy. *(Phase 3)*
- **Spend guard for `e2e`** — the tier currently skips when `API_KEY` is absent.
  Skipping is right for a scaffold and wrong for a release gate, which should say
  it could not run rather than report green. *(Phase 10)*
- **Coverage** — not configured, and not obviously the right measure for a suite
  whose claims are properties rather than lines.
