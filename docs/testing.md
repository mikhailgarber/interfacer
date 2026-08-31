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
  condition on demand.
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
`test:agent`, `test:e2e`.

The steps `verify` chains are also runnable alone — `npm run build`, `typecheck`,
`lint`, `format:check` — and `npm run format` writes the formatting that
`format:check` only reports on.

**Build before test.** Tests import `@interfacer/dsl` through the workspace
symlink and the package's `exports` map into `dist/` — the same path a generated
capability takes, which is the point. The cost is that a stale or missing build
makes tests fail confusingly. `npm run verify` orders it correctly; running
`vitest` directly does not, and nothing in the runner config enforces it.

**Retries are pinned to zero** in `vitest.config.ts`, not left to a default. Phase
3 asserts that replaying one flow N times produces the same steps, the same
resolutions and the same result; a retry would mask exactly the nondeterminism
that test exists to catch. Raising it is a design decision, not a flake remedy.

## not yet decided

The runner config is the tier/location mapping and timeouts. These are real
decisions that nothing has made yet, listed here so they are not mistaken for
settled:

- **Fixture lifecycle** — whether the HTTP apps start in a `globalSetup` or per
  file, and how they are torn down. *(Phase 2)*
- **Port allocation and parallelism** — Vitest runs files in parallel workers by
  default. Fixture servers binding ports and integration tests launching browsers
  will collide unless ports are assigned per worker or the pool is constrained.
  *(Phase 2/3)*
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
