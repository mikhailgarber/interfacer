# interfacer

Interfacer is a tool allowing automatic generation of durable interface code for arbitrary websites/applications.

Given overall objective, interface details are discovered by LLM iteratively and interactively and process of obtaining the result is documented. This process produces durable capture of steps necessary to be done thru website/app interfaces so subsequent executions of this process can be done without LLM involved.

## scope

Interfacer drives **web browsers**, via Playwright. Desktop applications and other surfaces are out of scope and deliberately deferred.

The seam that keeps them reachable is a single type. Element targets are a discriminated value rather than an opaque selector string:

```ts
export type Target =
  | { via: 'css'; selector: string };   // the only member today

export const css = (selector: string): Target => ({ via: 'css', selector });
```

A bare string wherever a `Target` is accepted is shorthand for `css(...)`, and `flow.describe()` normalizes it to the object form, so a recorded flow never stores a naked selector. Adding `{ via: 'role' | 'ax' | 'uia' }` later is purely additive: existing artifacts keep their meaning and none needs rewriting.

That is the whole abstraction. There is no `Driver` interface, no surface registry, no plugin mechanism — a second driver is a mechanical refactor once a second surface actually exists, and building it beforehand would be speculative. The remaining browser assumptions are accepted as such: `.open()` takes a URL, DOM snapshots appear in evidence, and a session is a live browser process.

## durable artefact

Captured process needs to be expressed in a form suitable for:
* human and LLM reviews
* versioning
* modification
* subsequent repeated execution without LLM present

The perfect design for that is simply code. Therefore, Interfacer produces a complete Node/TypeScript software project at a given location. Once that project is built, this particular interface can be exercised by executing the project's entry point.

Because the artifact is a program, its contract is expressed directly in TypeScript types (see "master function contract" below). Inputs, outputs, and the declared business outcomes are all type-level declarations, so the compiler checks them and every other representation — the CLI argument parser, the MCP tool schema, the generated documentation — is projected from them at build time rather than maintained by hand.

The step sequence is not executed eagerly. DSL calls accumulate into an in-memory flow object carrying an explicit capability `id` and `version`, and `flow.describe()` returns that sequence as structured data. The program stays the single source of truth, while steps remain diffable and reviewable by an LLM, without a parallel schema file that can drift out of sync with the code.

Every DSL call carries a stable step id, so errors and evidence refer to `login.submit` rather than to a position that shifts whenever the flow is edited.

## interfacer application

Interfacer itself is a Node/TypeScript application runnable on any of supported platforms (Mac arm and Intel, Windows - WSL and Linux amd64)

Node and TypeScript throughout, for Interfacer and for the projects it generates:

* The DSL library is shared — generated projects execute against it, and Interfacer executes against it during discovery — so it is an npm package wrapping Playwright.
* Generated projects are imported into a caller's codebase and launched as MCP servers. Both assume npm.
* One toolchain, one dependency graph, one test setup.

Interfacer is run with `npx interfacer`, so there is nothing to install beyond Node and Playwright's browsers.
Interfacer executable takes the following command-line parameters:
1. "project-name": short name for interface ("mybank-interface")
2. "root": on-disk location for generated products, defaults to the current directory
3. "interview": optional path to a file of pre-answered interview questions; supplying it makes the run non-interactive

When interfacer runs, 
* it checks if specified location ("root/project-name") exists
* if it is missing, Interfacer creates it
* if it is empty, Interfacer sets up the project in that location
* if it is not empty, Interfacer will reuse the code that is already there (project update)
* once location is determined, Interfacer drops into "interview" mode

### interview mode 

In interview mode, Interfacer will use LLM to ask the user the series of questions. User will:
* provide description of the task ("login to mybank.com, locate my checking account, retrieve account balance")
* provide description of the task's input as list of property names. If expected datatype of a property is NOT string, this should be specified as well ("interface input consists of username string and password string")
* mark which of those inputs are **secrets** — credentials, tokens, anything that must never be persisted or logged ("password is a secret"). A secret is typed `Secret<string>` in the generated contract, never written into the artifact or the trace, and never accepted as a command-line argument
* provide description of task's expected output — the shape returned when the task succeeds ("json object with one property, balance, and numeric value")
* provide the **business outcomes** the task can legitimately end in besides success ("the account may not exist", "the user may not be authorized to view it"). Each becomes an arm of the result union; generation mode is then responsible for discovering the page condition that detects it
* provide the **interaction points**: any place the task must stop and ask for something partway through — a value that cannot be known in advance ("login sends an MFA code to my phone") or an approval for a risky step. Each becomes a declared, typed interaction in the contract
* answer two **effects** questions: "does this only read, or does it change something?" and, if it changes something, "if this ran twice by mistake, would that be a problem?" The remaining effect dimensions are proposed by Interfacer and confirmed by the user
* confirm the **allowlist** Interfacer proposes from the task description — the concrete hosts the automation may visit

The last questions are the ones users do not volunteer on their own, so Interfacer asks them directly: "what else can happen instead of success?" and "will this ever stop and ask you for something?" An outcome that is not declared here cannot be returned, cannot appear in the generated MCP schema, and will surface at replay time as a hard failure. A declared interaction, conversely, tells a caller in advance that this capability cannot run unattended. The interview is therefore where the caller's error, interaction, and safety contract is actually decided, not an afterthought of generation.

Where Interfacer proposes rather than asks, the user still confirms. A model that resolves its own guardrails is authoring the constraint it is bound by.

Once Interfacer confirms with the user that all the parameters are described, Interfacer will switch to "Generation Mode".

#### pre-answered interviews

`--interview <path>` supplies answers up front. The file is a starting point rather than a replacement: Interfacer already has to judge whether it has enough to proceed, so a partial file simply narrows what is left to establish.

The flag also makes the run non-interactive. If the answers are insufficient, Interfacer exits listing which ones are missing rather than blocking on a question nobody is present to answer; filling those in and re-running is the loop.

Presence in the file counts as confirmation, which matters for the two things Interfacer proposes rather than asks — the allowlist and `securityEffect`. Unattended there is nobody to confirm them, so a proposal for either that is absent from the file is a missing answer and fails, rather than being accepted silently. A human wrote and committed the file, so the file is the authorization record.

After an interactive run Interfacer writes the completed answers back. The next run of the same capability is then reproducible, the demo path is a single command, and recording the same capability against another tenant starts by copying that file and changing the host.

#### discovery budget

A non-interactive run also needs a spending bound, since nothing is watching it. The budget is an answer in the interview file like any other, expressed as **cost** rather than steps or elapsed time: steps are not comparable to one another, elapsed time punishes a slow application rather than a stuck agent, and a hung navigation already dies on its `pauseUntil` bound. Cost is also the only unit meaningful to the person authorizing it, and the only one that scales to recording hundreds of capabilities.

Exhausting the budget is the same outcome as insufficient answers because it is the same failure: the file did not authorize the run to completion — once for *what* to do, once for *how much* to spend doing it. Interactively the cap is not a failure but a `pauseForApproval` — *spent $5, reached the account list, roughly 70% of the way, continue?* — where approving raises the ceiling and resumes without losing what was already paid for. Only an unattended run has nobody to ask, so only it exits.

A second guard is not authored: some number of consecutive steps with no change in page state ends the run whatever budget remains. That detects the real failure — an agent retrying the same thing — rather than proxying it through a number, and nobody wants to authorize thrashing.

Spend is computed by Interfacer from the `usage` on every response, counting cached and uncached input at their own rates — discovery resends history constantly, so cache reads dominate the token count while contributing little to cost. The budget is also passed to the model as an advisory ceiling, so it paces itself and stops with a diagnosis rather than being severed mid-step; but the model is only informed, never the enforcer, and the harness holds the hard cap. On exhaustion Interfacer writes back the completed answers and the partial flow, as an interactive run does, so re-running with a raised budget continues instead of restarting.

### generation mode

In generation mode, Interfacer will use LLM to iteratively perform the task user specified and document how this is done, step by step.

If necessary, LLM will ask user to provide "live values" (values matching input parameters already specified that can be used to try to achieve the task)

LLM will try to navigate website using appropriate third party library ("playwright"). As part of Interfacer code, there is a library of primitives ("typescript DSL") that wrap playwright primitives to provide easy-to-follow documentation of the discovered process. 

The DSL never embeds live values. Values collected during the interview become typed input parameters, and the flow refers to them by accessor rather than by literal, so the generated artifact is parameterized by construction and contains no credentials or PII.

The end result looks something like this:

```ts
const checkAccountBalanceFlow = new Flow<CheckAccountBalanceInput, CheckAccountBalanceResult>({
  id: 'checkAccountBalance',
  version: '1.0.0',
})
  .open(i => i.url)
  .fillForm('#login_field', i => i.username)
  .fillForm('#password', i => i.password)     // Secret<string> — redacted in every log and trace
  .pressButton('input[type="submit"]')
  .pauseForInput('mfaCode', { prompt: 'Enter the 6-digit code sent to your device' })
  .pauseUntil('#account-summary', { within: '30s' })   // resume predicate, never a fixed sleep
  .fillForm('#account-ref', i => i.accountRef)
  .pressButton('#lookup')

  // Declared business outcomes: legitimate answers, not failures.
  .outcome('#error-banner:has-text("No such account")',
    i => ({ status: 'account_not_found', accountRef: i.accountRef }))
  .outcome('#error-banner:has-text("Not authorized")',
    () => ({ status: 'permission_denied', requiredRole: 'TELLER' }))

  .checkpoint('#balance-value')
  .extract('balance', '#balance-value', Number)
  .returns(({ balance }) => ({ status: 'ok', balance }));

// Execute the flow live in a visible window during discovery.
checkAccountBalanceFlow.run(liveValues, { headless: false });
```

Selectors above are `css` shorthand (see Scope); the targeting strategy is specified separately.

During generation phase, LLM will gradually build up these DSL expressions, try to execute them until task is achieved.

### Interfacer and LLMs

Interfacer is an AI agent that drives an LLM through tool calling. It uses the Claude API through the official TypeScript SDK (`@anthropic-ai/sdk`), with `claude-opus-5` as the default model and adaptive thinking enabled. The model id is configuration, not a constant.

Provider portability is a seam, not an abstraction layer. Every SDK call lives in one module behind a single `decide(state, tools)` function, and nothing else in Interfacer imports the SDK — so moving to another provider means rewriting that one module. There is no provider registry, no lowest-common-denominator message format, and no attempt to support two providers at once.

Interfacer owns the agent loop rather than delegating it to an SDK helper, because the allowlist check, the step recording, and the evidence capture all happen between turns.

### Interfacer DSL library

Typescript primitives forming the Interfacer DSL are supplied vy Interfacer DSL library. In addition to wrapping Playwright, they provide standard logging and tracing and error handling. 

#### pause and resume

Execution never sleeps for a fixed duration and hopes. It **pauses** on an explicit resume predicate with a bound; a duration only ever bounds how long that predicate may stay false. `.wait(2000)` cannot distinguish "loaded in 200ms" from "never loaded"; a predicate can.

Waiting and human escalation are the same primitive: suspend, let something outside the flow change the world, resume after re-checking a precondition. They differ only in the resolver.

| pause reason | primitive | resolver | on bound expiry |
| --- | --- | --- | --- |
| awaiting-surface — load, spinner, transient slowness | `.pauseUntil(predicate, { within })` | polling | retry, then hard failure |
| awaiting-input — a value not knowable in advance (MFA, one-time token) | `.pauseForInput(name, { prompt })` | human, or a registered service | hard failure |
| awaiting-decision — a risky or irreversible step needs approval | `.pauseForApproval(prompt)` | human, returns approve/deny | treated as deny |
| awaiting-action — a human must operate the session (unexpected dialog, uncovered screen) | `.pauseForOperator(reason)` | human, on the live session | hard failure |

Two rules:

* **Declared vs undeclared.** A pause named in the flow is part of the contract, not an incident: MFA on every login is expected, and a capability that declares it is simply attended rather than broken. Only an undeclared pause is an escalation.
* **Resume re-asserts a checkpoint.** After a human touches the session the flow cannot assume where it is, so resume validates a checkpoint before continuing; a mismatch is a hard failure, not a blind continuation.

Every pause is bounded — an escalation nobody answers becomes a hard failure with evidence, never a hang. Control transfer is recorded as evidence: who held control, for how long, and before/after state.

#### error categories

Errors are categorized by who needs to act on them, and each category surfaces through a different mechanism:

* **Business outcome** — a legitimate answer to the question the caller asked ("no such account", "not authorized"). The run succeeded: it found out something true. Returned as a member of the master function's result union, never thrown. Every business outcome a capability can produce is declared in the flow together with the page condition that detects it.
* **Recoverable** — a transient or known-interstitial condition: a slow load, a dismissable dialog, a retryable timeout. Handled inside the DSL by waiting, retrying, or dismissing. Recorded in the trace as evidence, but never surfaced to the caller. Retry is gated on idempotency: a step whose capability declares `idempotent: false` is never retried, because a timed-out `pressButton` on a transfer may already have committed. Such a step escalates instead of retrying.
* **Hard failure** — the flow could not continue and no declared outcome matched: a checkpoint never satisfied, an expired session, an unreachable surface, an unexpected application error. Thrown as a typed exception carrying the step index, what was expected, what was observed, and a path to the captured evidence.

Detection order matters. When a checkpoint is not satisfied, the engine first evaluates the declared business-outcome detectors, and raises a hard failure only if none of them match. Without that ordering every business outcome would arrive as a crash, which is precisely the distinction this taxonomy exists to preserve.

UI drift is deliberately not a top-level category. The target applications are stable business systems, so drift is rare relative to genuine runtime conditions; when it does occur it surfaces as a hard failure like any other.

## safety policy

### allowlist

The allowlist is derived from the interview rather than hand-written, so it cannot drift away from what the capability actually does. There are two of them, with different sources and lifetimes:

| | discovery | replay |
| --- | --- | --- |
| source | proposed by the LLM from the task description, **confirmed by the user** | computed from the recorded flow |
| width | wider — the agent explores pages that will not survive into the final flow | exactly the origins the artifact touches |
| purpose | guardrail on a non-deterministic model | tripwire: leaving it means the application changed |

The confirmation step is not optional. "login to mybank.com" leaves `auth.mybank.com`, an SSO redirect to a third-party identity provider, and `cdn.mybank.net` undecided; a model that settles those edge cases for itself is authoring its own constraint. Interfacer proposes concrete host patterns, the user confirms, and the confirmed list is stored explicitly in the project.

The discovery allowlist is also the prompt-injection backstop: the agent reads page content, page content can contain instructions, and the allowlist is what stops a successful injection from becoming a navigation anywhere.

The replay allowlist requires no user input at all and is strictly tighter. Any navigation outside it is a hard failure.

Enforcement lives inside the DSL rather than around the process. Every navigation is checked where the DSL performs it — `.open()`, an activation that navigates, a popup or new tab — because the decision is per navigation: a process-level network permission cannot tell a legitimate page load from one an injection asked for. The check applies to the *resolved* URL after redirects, since an allowed host can redirect off-list.

### effects

Every capability declares its effects. They are published in the contract so a caller can see them before invoking, and each dimension drives a specific enforcement rather than a vague risk score.

| dimension | values | enforcement |
| --- | --- | --- |
| `mutates` | read / write | `read` plus a `pressButton` on a non-navigation control is a violation |
| `reversible` | yes / compensable / no | `no` requires approval before the commit step |
| `securityEffect` | none / authority-change / control-override | anything but `none` forces approval and attended execution |
| `scope` | single / bounded(N) / unbounded | runtime counter; exceeding N is a hard failure |
| `external` | none / notifies-customer / third-party | approval, and always recorded in evidence |
| `financial` | none / moves-funds(cap) | the amount parameter is checked against the cap before submit |
| `idempotent` | yes / no | `no` forbids retry on that step |
| `dataClasses` | non-identifying / PII / full-PAN / SSN | governs redaction and what evidence may be captured |

A rolled-up risk level may be shown in a capability catalog, but enforcement always keys off the individual dimensions; rolling up loses the ability to say that "unbounded but read-only" is fine.

Two of these are correctness rather than policy: `idempotent` changes the retry machinery, and `dataClasses` gates evidence capture.

#### securityEffect

This dimension exists because the others score account takeover as low risk. Changing a password is `write`, `reversible` (change it back), `financial: none`, `scope: single` — and is the last step of taking over an account. The harm is not that the effect is permanent; it is that the action changes **who can access the account afterwards**.

`authority-change` covers passwords, MFA devices, joint owners and authorized signers, registered email or phone (the recovery channel, which fraud teams treat as the highest-risk non-monetary event), mailing address, and internal staff roles or entitlements. `control-override` is its sibling: lifting a fraud hold, dismissing an alert, whitelisting a payee — granting no access and moving no money, but disabling a control.

Interfacer proposes the value from signals observed during discovery: an `<input type="password">`, field labels matching a lexicon (password, PIN, MFA, OTP, authenticator, owner, signer, role, entitlement, email, phone), a `Secret`-typed input being *written* rather than used to authenticate, routes such as `/security` or `/users/*/roles`, and confirmation text like "your password has been changed".

The default is inverted for this dimension alone: where the signals are ambiguous Interfacer assumes `authority-change` and requires the user to say otherwise. For every other dimension a wrong guess costs friction; here a false negative means an account-takeover flow running unattended and unapproved.

### evidence and sensitive data

Two requirements collide: evidence needs a rich signal on failure, and regulated data must never be persisted into logs. A failure screenshot of a back-office screen showing an account number and an SSN is precisely the forbidden thing. `dataClasses` arbitrates:

| dataClasses | evidence permitted |
| --- | --- |
| non-identifying (balance, status) | full screenshot, DOM snapshot |
| PII | screenshot with sensitive nodes masked; DOM snapshot with values stripped, structure kept |
| full-PAN, SSN | no pixels; structural evidence only |

Little diagnostic power is lost, because debugging needs structure rather than values: "the balance field was present but empty" localizes a fault as well as the figure itself would.

Redaction happens **at capture time**, not before writing. Playwright's screenshot takes a mask of locators and paints over them before encoding, so an unredacted image never exists in a buffer or a temp file.

This applies to more than screenshots. Traces embed DOM and network bodies, and the leakiest artifact is the discovery transcript, since the LLM receives page content directly as input. `dataClasses` therefore also governs what may be sent to the model and what the transcript retains.

`Secret` and `dataClasses` solve different halves of one problem: `Secret` protects values the caller supplies, `dataClasses` protects values the automation observes.

## multi-tenant

Hundreds of institutions run the same vendor products, configured, branded, and versioned differently. Interfacer's answer is deliberately blunt: **one project per tenant variant**, with no inheritance, base flows, or override layers.

Pure instance differences are already handled, because the entry point is an ordinary input parameter — one project serves every tenant that differs only by hostname. Past that, the differences are structural rather than value-shaped: an extra branch-selection step, a consent interstitial, a screen split in two between releases, a differently worded "no such account" banner. An override layer able to insert and reorder steps is just a flow with indirection, and discovery is cheap enough that re-recording beats maintaining one. A per-tenant artifact is also easier to audit: "which automation ran against this institution" is answered by a file rather than reconstructed from a base plus a patch.

What is reused across tenants is Interfacer and the DSL library, not the artifacts. Each project declares `{capability, vendor, version, tenant}` so a caller can ask for a capability by tenant and be routed to the right project.

Two guards:

* **Variant stamp.** Each project records what it was discovered against — host, observed application version, date. The realistic failure here is not re-recording but copying a sibling project and changing the URL, which leaves outcome detectors matching the wrong wording and silently degrades a business outcome into a hard failure. The stamp makes that mismatch detectable.
* **Seeded discovery.** Recording a new variant starts from a sibling project's flow as a proposed answer, and the LLM confirms or repairs only the differences — convergence at generation time, no indirection at replay time.

## generated project / application

The end result of generation phase is sequence of DSL expressions that achieves the desired task without LLM present. This typescript code is placed into desired location and set up to be executable as a Node package

Generated project is fully self-contained, it has appropriate npm setup, etc. 

Project executable (or master file) has provisions to take specified parameters as command line arguments ("--username user35"). Parameters typed as `Secret` are never accepted on argv; they are read from the environment or from stdin, so they do not land in shell history or in process listings.

### master function contract

There is a well defined master function that takes a well-typed input object and returns a well-typed result union. These types are the capability's contract; everything else is generated from them.

The DSL library supplies a `Secret` type for any value that must never be persisted or logged:

```ts
declare const secretBrand: unique symbol;

export interface Secret<T = string> {
  readonly [secretBrand]: true;
  reveal(): T;          // explicit, and the only way to read the value
  toString(): string;   // always "[redacted]"
  toJSON(): string;     // always "[redacted]"
}
```

`Secret` makes redaction the default rather than a logging convention that has to be remembered at every call site: string interpolation and `JSON.stringify` both yield `[redacted]`, so a secret can reach the page only through an explicit `.reveal()` inside a DSL primitive.

The capability's input and result types are then plain declarations:

```ts
export interface CheckAccountBalanceInput {
  url: string;
  username: string;
  password: Secret<string>;
  accountRef: string;
}

export type TerminalResult =
  | { status: 'ok'; balance: number }
  | { status: 'account_not_found'; accountRef: string }
  | { status: 'permission_denied'; requiredRole: string };

export type Suspended =
  { status: 'suspended'; sessionId: string; request: InteractionRequest };

// A resolver is supplied: the engine asks and loops internally, never suspending.
export function checkAccountBalance(
  input: CheckAccountBalanceInput,
  opts: { resolver: Resolver },
): Promise<TerminalResult>;

// No resolver: nowhere to ask, so the run parks.
export function checkAccountBalance(
  input: CheckAccountBalanceInput,
): Promise<TerminalResult | Suspended>;
```

`suspended` is a control state, not a business outcome, and it is precisely what you get when no resolver is available. The overloads make that visible in the type: a caller that supplies a resolver never handles the arm at all.

```ts
export interface InteractionRequest {
  kind: 'input' | 'approval' | 'operator';
  name: string;
  prompt: string;
  secret: boolean;
  expiresAt: string;
}

export type InteractionResponse = Secret<string> | boolean | 'done';
export type Resolver = (req: InteractionRequest) => Promise<InteractionResponse>;

export function resume(
  sessionId: string,
  response: InteractionResponse,
): Promise<TerminalResult | Suspended>;
```

One resolver handles every kind rather than a callback per kind: the set of kinds will grow, and caller policy ("deny every approval when unattended") then lives in one place instead of three. The CLI's keyboard reader is just the built-in resolver.

Declared interactions are published alongside the types, so a caller knows before invoking that this capability will stop and ask:

```ts
export const interactions = {
  mfaCode: { kind: 'input', secret: true, prompt: 'Enter the 6-digit code sent to your device' },
} as const;

export const requiresAttendedSession = true;

export const effects = {
  mutates: 'read',
  reversible: 'yes',
  securityEffect: 'none',
  scope: 'single',
  external: 'none',
  financial: 'none',
  idempotent: true,
  dataClasses: ['non-identifying'],
} as const;
```

The result union carries success and every declared business outcome, so a caller that handles all arms of the union has handled every answer the capability can give. Hard failures are thrown instead, as typed exceptions:

```ts
export class ReplayError extends Error {
  readonly step: number;
  readonly expected: string;
  readonly observed: string;
  readonly evidencePath: string;
}

export class CheckpointFailed extends ReplayError {}
export class SessionExpired extends ReplayError {}
export class SurfaceUnavailable extends ReplayError {}

export function isReplayError(e: unknown): e is ReplayError;
```

`isReplayError` is exported because TypeScript types a `catch` binding as `unknown` and has no `throws` clause. Without the guard, consumers lose the typing at the one place they need it.

### session registry

A parked run is held in an in-process `Map<sessionId, SuspendedRun>` next to the browser handle. The session state *is* a live browser process, not a serializable record, so `sessionId` is a handle to a process rather than a key into a store: it is resumable only from the process that owns it.

* CLI and library resolve inline, so the map is usually never consulted.
* The MCP server process holds the map for the life of the server. That is the only long-lived component, and it needs no database, queue, or cross-host addressing.
* Every parked session has a TTL. Expiry kills the browser and marks the run a hard failure with evidence, so a forgotten session cannot leak a browser process.
* `resume` is single-shot; a second call on the same id is an error.

Deliberate cut: parked sessions die with the process. A live browser cannot be restored mid-flow, so recovery after a crash means re-running from step 0 with restored storage state — re-execution, not resume.

### how to use generated project

The same contract projects onto three surfaces. Each maps the result union and the thrown errors onto its own conventions:

* **run from command line** — success and business outcomes both print the result object as JSON and exit 0, because both are answers. A hard failure prints the error and the evidence path to stderr and exits nonzero. A `suspended` result is handled in-process by a default resolver that prints the prompt and reads the response from the keyboard, then calls `resume` — so the command still looks like a single blocking invocation. For `operator` pauses the browser is already headed: the flow simply stops driving it, the human uses that same window, and Enter signals resume.
* **integrate into larger codebases using master function** — call it directly: `switch` on `result.status` for outcomes, `try`/`catch` with `isReplayError` for hard failures. Supply a `resolver` and the `suspended` arm never appears; omit it only if the host wants to park runs itself.
* **make it available as MCP for other LLMs** — the tool's input and output schemas are generated from the TypeScript types, so a calling LLM sees `account_not_found` as a declared possible answer. Business outcomes come back as normal tool results; only hard failures set `isError`. `suspended` is returned as a normal result with a companion `resume` tool, because an MCP tool cannot call back into its caller mid-execution — the agent obtains the value however it can and calls `resume` with the session id.

The MCP case is the sharpest argument for returning business outcomes rather than throwing them. An exception crossing the MCP boundary becomes an opaque tool error, and the calling agent can no longer distinguish "this account does not exist" from "the application is broken" — which is the one distinction it most needs in order to decide what to do next.

### local MCP

As part of project generation, provisions are made to make it invokable as local MCP by Claude etc






