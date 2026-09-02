# working in this repo

Interfacer turns an English task and an entry point into a **capability**: a typed,
versioned Node/TypeScript project that drives a web app through Playwright with no
model in the replay path. See [README.md](README.md) for the shape of it.

## the three docs, and which is which

- **[docs/design-requirements.md](docs/design-requirements.md)** is the authority. It
  says what this is and why it is shaped the way it is, including what is deliberately
  **rejected** (a serialized artifact, general branching, the model authoring
  TypeScript, coordinates as targets, override layers, a provider abstraction, a model
  anywhere in the replay path). Implementing a rejected thing breaks a property the
  rest of the design depends on. If something is genuinely unspecified, say so and ask
  rather than inventing — and if the answer settles a design question, the design doc
  is what gets amended. It is also the **claim registry**: a statement a test could
  falsify carries an inline marker naming a claim id and the phase that should prove
  it, rendered as a superscript `c` and read by `npm run claims`. Adding a statement
  of that kind means adding a marker; see testing.md's *design-claim coverage* for
  the exact form, where it goes, and what earns one.
- **[docs/implementation-plan.md](docs/implementation-plan.md)** is the ordered build:
  eleven phases, each closed by a test tier. Amend it when the *plan* changes.
- **[README.md](README.md)** and **[docs/testing.md](docs/testing.md)** describe what
  *exists now*. Amend them when the *code* changes — see below.

## keep the docs true

**When a change alters what exists — a package, module, script, test tier, command, or
how the gate runs — update `README.md` and `docs/testing.md` in the same change.**

Those two are the only docs claiming to describe the present state, so they are the
only two that go stale in a way that misleads. A README still announcing an earlier
phase, or a testing doc listing a settled question as open, reads as fact.

Specifically: README's **status**, **features**, **layout** and commands block;
testing.md's tier table, test locations, running-it commands, and its
**"not yet decided"** list — move an item out of that list the moment the phase owning
it settles the question, and add one when a new open question appears. A new
`package.json` script means a new line in the docs that list commands; a script nothing
documents is a script nobody runs.

## the gate

```sh
npm run verify    # build -> typecheck -> lint -> format:check -> test
```

GitHub Actions runs `npm run verify` on each push to `master`, inside this repository's
Dev Container. `verify` is the whole gate, and it must be green before any work is
presented as done.

**Build before test.** Tests import `@interfacer/dsl` and `@interfacer/fixtures`
through the workspace symlink and each package's `exports` map into `dist/` — the same
path a generated capability takes, which is the point. Running `vitest` directly
against a stale build fails confusingly; `verify` orders it correctly. `npm run watch`
keeps `dist/` current while editing.

The editor resolves through `dist/` too. An IDE diagnostic that `npm run lint` does not
reproduce — typically "type that cannot be resolved" on a cross-package import — is a
language server that cached a failed module resolution before the package was built.
Rebuild, then restart the TypeScript and ESLint servers. Do not "fix" the code for it.

## tests

Five tiers; a test's tier is its **filename suffix**, not its directory
(`*.unit.test.ts`, `*.fixtures.test.ts`, `*.integration.test.ts`, `*.agent.test.ts`,
`*.e2e.test.ts`, plus `*.test-d.ts` for type-level tests). `test/suite.unit.test.ts`
fails the run if a test file matches no tier — otherwise it would never be collected
and its assertions would silently never run. Full conventions in
[docs/testing.md](docs/testing.md).

Two rules from the design that are easy to violate without noticing:

- **Prefer fakes to mocks.** This design deliberately has few seams, and those are
  exactly where mocks attach — a mock-heavy suite generates pressure to reintroduce
  the abstractions the design rejects, purely for testability.
- **Integration tests drive the engine, not Playwright.** Author a `Flow` and call
  `.run()`; never `page.click()`. The single current exception is
  `packages/dsl/test/browser.integration.test.ts`, which exists to prove the browser
  toolchain works and says so in its own header.

Assert on outcomes, not on call counts. A test asserting that `decide` was called
twice with particular arguments is a mock wearing a fake's clothes.

## conventions

- **TypeScript is pinned to `~6.0.x`.** TS 7 is released, but `typescript-eslint`
  peers at `<6.1.0`, and losing type-aware linting is the wrong trade for a design
  this type-heavy. Revisit when typescript-eslint supports 7.
- **Comments carry the *why*.** The compiler and the test names already say what the
  code does; a comment earns its place by recording the reasoning that would otherwise
  be lost — usually a sentence from the design doc about what a rule protects against.
- **Placeholders name the phase that deletes them.** A scaffold export or a
  not-implemented stub carries a comment saying which phase replaces it.
- **Do not reformat the prose docs.** `docs/`, `README.md` and `CLAUDE.md` are
  Prettier-ignored on purpose: reflow noise buries real edits.
- **Nothing is committed unless asked.** Present the work and let the user decide.
