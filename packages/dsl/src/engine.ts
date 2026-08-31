/**
 * The execution engine: one engine, walking a flow.
 *
 * Replay is this engine walking a finished flow with no model attached. It is
 * the path an agent triggers in production, and the only one that runs at
 * volume. Discovery is the same engine walking a flow the model is still
 * appending to — not a different way of executing, only a different way of
 * deciding what to execute next, which is what makes "it worked during
 * discovery" a claim about replay rather than about a prototype.
 *
 * Determinism here is a claim about the decision procedure, not about the world:
 * the same inputs produce the same steps, resolved the same way, verified
 * against the same conditions, every run. It does not mean the application
 * returns the same data — a balance changes between runs — and a capability
 * written as though it would is simply wrong.
 *
 * Every step runs the same cycle: **resolve → act or observe → verify →
 * record**. The DSL primitives are the only place the engine is instrumented, so
 * evidence is uniform across every capability and cannot be forgotten.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from 'playwright';

import { checkAllowlist, type HostPattern } from './allowlist.js';
import { capture, type AttachmentTrigger } from './attachments.js';
import { evidencePolicyFor, redactUrl } from './effects.js';
import {
  ApprovalDenied,
  CheckpointFailed,
  InteractionFailed,
  NavigationBlocked,
  PauseExpired,
  ReplayError,
  SurfaceUnavailable,
  TargetAmbiguous,
  type ReplayErrorDetail,
} from './errors.js';
import type { FieldSet, Infer } from './fields.js';
import type { ActionStep, FillValue, Flow, OutcomeDeclaration, PauseStep, Step } from './flow.js';
import {
  checkResponse,
  DEFAULT_PARK_TTL_MS,
  type InteractionRequest,
  type InteractionResponse,
  type PauseKind,
  type Resolver,
  type Suspended,
} from './pause.js';
import {
  createEmitter,
  createEntryFactory,
  DEFAULT_DESTINATION,
  type Entry,
  type EntryBody,
  type EntryEvidence,
  type PauseReason,
  type Phase,
  type RecordDestination,
} from './record.js';
import { isDrift, resolveTarget, type Resolution } from './resolve.js';
import type { Secret } from './secret.js';
import { PauseTimeout, RunSession } from './session.js';
import { describeTarget, type TargetChain } from './target.js';
import { decideVerification } from './verification.js';

export interface RunOptions {
  /** Replay is headless by default; discovery is headed so a human can watch. */
  readonly headless?: boolean;
  /**
   * Hosts beyond the entry point's own origin. Defaults to what the flow
   * declares.
   */
  readonly allowlist?: readonly HostPattern[];
  /** Take the entries directly. Overrides {@link destination}; a test's way in. */
  readonly record?: (entry: Entry) => void;
  /**
   * Where the run record goes. One JSON object per line on stdout by default.
   *
   * An MCP entry point must select `'stderr'` or a file: stdout is the protocol
   * transport there, and entries written onto it corrupt the protocol.
   */
  readonly destination?: RecordDestination;
  /**
   * Where attachments are written. Absent means none are.
   *
   * Rich capture is opt-in because a screenshot cannot go to a stream and has to
   * land somewhere somebody chose — which also suits the data-handling story.
   * Where no directory is configured a trigger records that it skipped, rather
   * than silently producing less than the reader expects.
   */
  readonly attachmentDir?: string;
  readonly runId?: string;
  readonly capabilityVersion?: string;
  readonly phase?: Phase;
  /** Injectable so a record is reproducible in a test. */
  readonly now?: () => Date;
  /** Reuse a browser across runs. The engine never closes one it did not open. */
  readonly browser?: Browser;
  /** How long a first-choice strategy may take to appear. */
  readonly timeoutMs?: number;
  /**
   * How many times a *retryable* step may be re-attempted.
   *
   * Gated per step, not per capability: gating on the capability would forbid
   * retrying the twenty safe steps that precede the one dangerous one, which is
   * how a mutating capability becomes needlessly brittle.
   */
  readonly retries?: number;
  /**
   * Who answers a pause.
   *
   * Supplied: the engine asks and loops internally, and the run never suspends —
   * which the overloads below make visible in the type. Omitted: there is
   * nowhere to ask, so the run parks and the caller gets a {@link Suspended}.
   */
  readonly resolver?: Resolver;
  /** How long a parked run may sit before it is killed. */
  readonly ttlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_RETRIES = 1;

/** What each interaction kind is recorded as. */
const PAUSE_REASON: Readonly<Record<PauseKind, PauseReason>> = {
  input: 'awaiting-input',
  approval: 'awaiting-decision',
  operator: 'awaiting-action',
};

/** A step that commits nothing, and so may be attempted again. */
function isRetryable(step: Step): boolean {
  // Resolution, reads, navigation and ordinary presses commit nothing.
  // `.commit()` never retries, because a timed-out commit may already have gone
  // through and repeating it is worse than failing.
  return step.kind !== 'commit';
}

function stepTarget(step: Step | ActionStep): TargetChain | undefined {
  return 'target' in step ? step.target : undefined;
}

function describeChain(chain: TargetChain): string {
  return chain.map(describeTarget).join(' | ');
}

/** The engine's own view of a step that did not work out. */
interface StepFailure {
  readonly expected: string;
  readonly observed: string;
}

/** Thrown internally when a declared outcome matches, to unwind the step loop. */
class Terminated extends Error {
  readonly answer: unknown;

  constructor(answer: unknown) {
    super('outcome matched');
    this.answer = answer;
  }
}

/**
 * Run a flow.
 *
 * The overloads are the master-function contract: a caller that supplies a
 * resolver never handles the `suspended` arm, because with somewhere to ask the
 * engine asks and loops internally. Omitting the resolver is the deliberate
 * choice to handle interaction yourself, and is the only way a run parks.
 */
export function runFlow<I extends FieldSet, A>(
  flow: Flow<I, A>,
  input: Infer<I>,
  options: RunOptions & { readonly resolver: Resolver },
): Promise<A>;
export function runFlow<I extends FieldSet, A>(
  flow: Flow<I, A>,
  input: Infer<I>,
  options?: RunOptions,
): Promise<A | Suspended>;
export function runFlow<I extends FieldSet, A>(
  flow: Flow<I, A>,
  input: Infer<I>,
  options: RunOptions = {},
): Promise<A | Suspended> {
  const ownsBrowser = options.browser === undefined;
  let browser: Browser | undefined = options.browser;
  let context: BrowserContext | undefined;

  // Closing the context always, and the browser only where the engine opened
  // it, keeps the standing rule that the engine never closes a browser it did
  // not open — even when a TTL is what is doing the closing.
  const dispose = async (): Promise<void> => {
    await context?.close().catch(() => undefined);
    if (ownsBrowser) {
      await browser?.close().catch(() => undefined);
    }
  };

  const session = new RunSession({ ttlMs: options.ttlMs ?? DEFAULT_PARK_TTL_MS, dispose });

  void execute().then(
    (answer) => {
      session.settle(answer);
    },
    (error: unknown) => {
      session.fail(error);
    },
  );

  return session.settlement as Promise<A | Suspended>;

  async function execute(): Promise<A> {
    const runId =
      options.runId ?? `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const emit = options.record ?? createEmitter(options.destination ?? DEFAULT_DESTINATION);
    // What `dataClasses` permits this run to capture. Computed once: it is a
    // property of the capability, not a judgement made fresh on each page.
    const policy = evidencePolicyFor(flow.effects.dataClasses);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options.retries ?? DEFAULT_RETRIES;
    const clock = options.now ?? ((): Date => new Date());
    const { resolver } = options;

    const entries = createEntryFactory(
      {
        runId,
        capabilityId: flow.id,
        capabilityVersion: options.capabilityVersion ?? '0.0.0',
        phase: options.phase ?? 'replay',
      },
      options.now === undefined ? {} : { now: options.now },
    );

    const record = (body: EntryBody, stepId?: string, evidence?: EntryEvidence): Entry => {
      const entry = entries.entry(body, stepId, evidence);
      emit(entry);
      return entry;
    };

    /**
     * Record an entry that a trigger hangs attachments off.
     *
     * The three triggers are the only moments rich capture happens: a hard
     * failure, a control transfer, and the `.commit()` step. Capture runs
     * *before* the entry is stamped, so the files can be named for the `seq`
     * the entry is about to carry and the reference is right the first time.
     */
    const recordWithCapture = async (
      body: EntryBody,
      stepId: string | undefined,
      trigger: AttachmentTrigger,
      page: Page | undefined,
    ): Promise<Entry> => {
      const seq = entries.nextSeq;

      if (page === undefined) {
        return record(body, stepId);
      }

      if (options.attachmentDir === undefined) {
        return record(body, stepId, {
          attachmentsSkipped: 'no attachment directory is configured',
        });
      }

      try {
        const attachments = await capture({
          page,
          dir: options.attachmentDir,
          runId,
          seq,
          trigger,
          policy,
        });
        return record(body, stepId, { attachments });
      } catch (error) {
        // A capture that fails must not turn a diagnosable failure into an
        // undiagnosable one, so it is noted and the entry still goes out.
        return record(body, stepId, {
          attachmentsSkipped: error instanceof Error ? error.message : 'capture failed',
        });
      }
    };

    browser ??= await chromium.launch({ headless: options.headless ?? true });
    const openBrowser = browser;

    // Origins the caller is entitled to reach. The entry point's own origin is
    // added when `.open()` resolves it: the caller chose where to point the
    // capability, so the allowlist is not there to second-guess that — it bounds
    // everywhere *else* the automation could be taken.
    const allowed = new Set<HostPattern>(options.allowlist ?? flow.declaredAllowlist);

    let blocked: { url: string; reason: string } | undefined;
    /**
     * The most recent checkpoint that passed.
     *
     * Kept because resume re-asserts it: after a human touches the session the
     * flow cannot assume where it is, so it validates a known state before
     * continuing rather than driving blind into whatever is on screen.
     */
    let lastCheckpoint: { id: string; target: TargetChain } | undefined;
    /**
     * The `seq` of the `pause` entry that most recently approved something.
     *
     * `null` where none has. An `effect.performed` carrying `null` is exactly how
     * a missing approval shows up in the record: present and unlinked, rather
     * than absent and unnoticed.
     */
    let approvedBySeq: number | null = null;

    try {
      context = await openBrowser.newContext();
      const page = await context.newPage();

      const isMainDocument = (request: Request): boolean =>
        request.resourceType() === 'document' && request.frame() === page.mainFrame();

      // Every navigation is recorded, redirect hops included. `page.route` is not
      // enough on its own: it fires for the request the engine makes and not for
      // the hops the browser follows, which is exactly the case the design cares
      // about — an allowed host can redirect off-list.
      page.on('request', (request: Request) => {
        if (!isMainDocument(request)) {
          return;
        }
        const decision = checkAllowlist(request.url(), [...allowed]);
        record({
          kind: 'navigation',
          // Judged on the real URL, recorded through `dataClasses`: an
          // application that puts a reference in a query string would otherwise
          // write a value the caller supplied straight into the record.
          url: redactUrl(request.url(), policy),
          allowed: decision.allowed,
          ...(decision.allowed ? { pattern: decision.pattern } : { reason: decision.reason }),
        });
      });

      // Enforcement lives where the DSL performs the navigation, because the
      // decision is per navigation: a process-level network permission cannot tell
      // a legitimate page load from one an injection asked for. This aborts the
      // request the engine itself issues; a redirect off-list is caught by
      // `enforceResolvedUrl` below, on the URL the navigation actually reached.
      await page.route('**/*', async (route: Route) => {
        if (!isMainDocument(route.request())) {
          await route.continue();
          return;
        }

        const decision = checkAllowlist(route.request().url(), [...allowed]);
        if (decision.allowed) {
          await route.continue();
        } else {
          blocked = { url: route.request().url(), reason: decision.reason };
          await route.abort('blockedbyclient');
        }
      });

      record({
        kind: 'run.started',
        inputNames: Object.keys(flow.input),
        secretInputNames: Object.entries(flow.input)
          .filter(([, field]) => field.kind === 'secret')
          .map(([name]) => name),
        dataClasses: flow.effects.dataClasses,
        effectsDeclared: flow.effectsDeclared,
      });

      const extracted: Record<string, unknown> = {};
      /**
       * What `.pauseForInput()` has obtained so far, passed to every accessor as
       * its second argument. Separate from `input` because it has different
       * provenance: asked for mid-run, never through a field declaration.
       */
      const obtained: Record<string, Secret> = {};

      try {
        for (const step of flow.steps) {
          await runStep(step);
        }
      } catch (error) {
        if (error instanceof Terminated) {
          record({
            kind: 'run.finished',
            status: { ending: 'outcome', status: describeAnswer(error.answer) },
          });
          return error.answer as A;
        }
        throw error;
      }

      const map = flow.result;
      if (map === undefined) {
        throw new CheckpointFailed('flow declares no result', {
          runId,
          step: flow.id,
          expected: 'a .returns() declaration',
          observed: 'none',
        });
      }

      const answer = (map as (values: Record<string, unknown>) => unknown)(extracted);
      record({ kind: 'run.finished', status: { ending: 'success' } });
      return answer as A;

      // ---- the step cycle -------------------------------------------------

      async function runStep(step: Step): Promise<void> {
        record({ kind: 'step.started', verb: step.kind }, step.id);

        if (step.kind === 'pause') {
          // Never round the retry-then-detect ladder. A refused approval or an
          // unanswered escalation is already a verdict, and re-asking would turn a
          // deny into a poll; letting the detectors see it would let an unrelated
          // banner explain away a human's decision.
          await runPause(step);
          return;
        }

        for (let attempt = 0; ; attempt++) {
          const failure = await attemptStep(step);

          if (failure === undefined) {
            return;
          }

          const attemptsRemaining = isRetryable(step) ? retries - attempt : 0;
          const decision = decideVerification({
            satisfied: false,
            detectors: await evaluateDetectors(flow.outcomes),
            recovery: { available: isRetryable(step), attemptsRemaining },
          });

          switch (decision.action) {
            case 'recover':
              // Recorded as evidence only; recovery never reaches the caller.
              record({ kind: 'retry', reason: failure.observed, attempt: attempt + 1 }, step.id);
              continue;

            case 'outcome': {
              const declaration = flow.outcomes[decision.index];
              if (declaration === undefined) {
                break;
              }
              record(
                { kind: 'outcome.matched', detectorIndex: decision.index, status: declaration.id },
                step.id,
              );
              throw new Terminated(
                (declaration.map as (value: Infer<I>, got: Record<string, Secret>) => unknown)(
                  input,
                  obtained,
                ),
              );
            }

            case 'proceed':
            case 'fail':
              break;
          }

          throw blocked === undefined
            ? await hardFailure(
                CheckpointFailed,
                step.id,
                `${step.id}: ${failure.observed}`,
                failure.expected,
                failure.observed,
              )
            : await hardFailure(
                NavigationBlocked,
                step.id,
                `${step.id}: navigation left the allowlist`,
                `a navigation within ${[...allowed].join(', ') || '(no hosts)'}`,
                `${redactUrl(blocked.url, policy)} (${blocked.reason})`,
              );
        }
      }

      /**
       * One attempt at a step. Returns `undefined` on success, or what went wrong.
       *
       * Ambiguity is not returned as a failure: it throws on the spot, because it
       * is never recoverable and never a business outcome — two elements answering
       * to the same description means the recorded intent is unclear, and no
       * amount of waiting or detecting changes that.
       */
      async function attemptStep(
        step: Exclude<Step, PauseStep & { kind: 'pause' }>,
      ): Promise<StepFailure | undefined> {
        if (step.kind === 'open') {
          return openEntryPoint(
            step.url as unknown as (value: Infer<I>, got: Record<string, Secret>) => string,
            step.id,
          );
        }

        if (step.kind === 'pauseUntil') {
          return waitForSurface(step);
        }

        if (step.kind === 'optional') {
          const resolution = await resolveTarget(page, step.target, 'unique', timeoutMs);
          if (!resolution.found) {
            // A no-op when the target does not resolve — an intermittent consent
            // screen that simply is not there today.
            return undefined;
          }
          for (const inner of step.steps) {
            const failure = await attemptStep(inner);
            if (failure !== undefined) {
              return failure;
            }
          }
          return undefined;
        }

        if (step.kind === 'oneOf') {
          for (const arm of step.arms) {
            const resolution = await resolveTarget(page, arm.when, 'present', timeoutMs);
            if (!resolution.found) {
              continue;
            }
            for (const inner of arm.steps) {
              const failure = await attemptStep(inner);
              if (failure !== undefined) {
                return failure;
              }
            }
            return undefined;
          }
          return {
            expected: `one of ${String(step.arms.length)} expected screens`,
            observed: 'no arm matched',
          };
        }

        const chain = stepTarget(step);
        if (chain === undefined) {
          return undefined;
        }

        const resolution = await resolveTarget(page, chain, 'unique', timeoutMs);

        if (!resolution.found) {
          if (resolution.reason === 'ambiguous') {
            throw await hardFailure(
              TargetAmbiguous,
              step.id,
              `${step.id}: ${String(resolution.matches)} elements matched`,
              `exactly one element for ${describeChain(chain)}`,
              `${String(resolution.matches)} elements matched strategy "${resolution.strategy}"`,
            );
          }
          return {
            expected: describeChain(chain),
            observed: 'no strategy in the chain resolved',
          };
        }

        return act(step, resolution);
      }

      async function act(
        step: Exclude<
          Step,
          { kind: 'open' } | { kind: 'optional' } | { kind: 'oneOf' } | PauseStep
        >,
        resolution: Resolution & { found: true },
      ): Promise<StepFailure | undefined> {
        try {
          switch (step.kind) {
            case 'fillForm': {
              const raw = (
                step.value as (value: Infer<I>, got: Record<string, Secret>) => FillValue
              )(input, obtained);
              // A secret reaches the page only through an explicit `.reveal()`,
              // and this is the one place in the codebase that call is made.
              const value = typeof raw === 'string' ? raw : raw.reveal();
              await resolution.locator.fill(value, { timeout: timeoutMs });
              break;
            }

            case 'pressButton':
              await resolution.locator.click({ timeout: timeoutMs });
              await settle();
              enforceResolvedUrl(step.id);
              break;

            case 'commit':
              await resolution.locator.click({ timeout: timeoutMs });
              await settle();
              enforceResolvedUrl(step.id);
              // Someone auditing a run should be able to answer *did anything
              // irreversible happen, and was it authorized* by reading the
              // record, not by inferring it from a `step.finished` on a button
              // press. This is the entry that answers it.
              await recordWithCapture(
                {
                  kind: 'effect.performed',
                  dimension: 'reversible',
                  value: flow.effects.reversible,
                  approvedBySeq,
                },
                step.id,
                'commit',
                page,
              );
              break;

            case 'choose': {
              const value = (
                step.value as unknown as (value: Infer<I>, got: Record<string, Secret>) => string
              )(input, obtained);
              await resolution.locator.selectOption(value, { timeout: timeoutMs });
              break;
            }

            case 'checkpoint':
              record({ kind: 'checkpoint', satisfied: true }, step.id);
              lastCheckpoint = { id: step.id, target: step.target };
              break;

            case 'extract': {
              const text = (await resolution.locator.textContent({ timeout: timeoutMs })) ?? '';
              extracted[step.name] = step.parse(text.trim());
              break;
            }
          }
        } catch (error) {
          // A hard failure raised here is already a verdict — an ambiguous target
          // or a navigation that left the allowlist. Folding it into a step
          // failure would send it round the retry-then-detect ladder, where it
          // could surface as a business outcome it has nothing to do with.
          if (error instanceof ReplayError) {
            throw error;
          }
          return {
            expected: describeChain(stepTarget(step) ?? ([] as unknown as TargetChain)),
            observed:
              error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : 'failed',
          };
        }

        record(
          {
            kind: 'step.finished',
            resolvedBy: resolution.strategy,
            strategyIndex: resolution.index,
            // A fallback winning is the drift signal: the application changed in a
            // way the artifact survived by luck.
            drifted: isDrift(resolution),
          },
          step.id,
        );

        return undefined;
      }

      async function openEntryPoint(
        accessor: (value: Infer<I>, got: Record<string, Secret>) => string,
        stepId: string,
      ): Promise<StepFailure | undefined> {
        const url = accessor(input, obtained);

        try {
          allowed.add(new URL(url).hostname);
        } catch {
          return { expected: 'a URL', observed: redactUrl(url, policy) };
        }

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs * 3 });
        } catch (error) {
          if (blocked !== undefined) {
            return {
              expected: 'a navigation within the allowlist',
              observed: redactUrl(blocked.url, policy),
            };
          }
          throw new SurfaceUnavailable(`${stepId}: could not reach ${redactUrl(url, policy)}`, {
            runId,
            step: stepId,
            expected: `a page at ${redactUrl(url, policy)}`,
            observed:
              error instanceof Error
                ? (error.message.split('\n')[0] ?? 'unreachable')
                : 'unreachable',
          });
        }

        enforceResolvedUrl(stepId);
        record(
          { kind: 'step.finished', resolvedBy: 'css', strategyIndex: 0, drifted: false },
          stepId,
        );
        return undefined;
      }

      /** Let a navigation caused by a click finish before the next step looks. */
      async function settle(): Promise<void> {
        await page
          .waitForLoadState('domcontentloaded', { timeout: timeoutMs })
          .catch(() => undefined);
      }

      /**
       * Judge where the navigation actually landed.
       *
       * The check applies to the **resolved** URL after redirects, since an
       * allowed host can redirect off-list — and a redirect is followed by the
       * browser without the engine's request interception seeing it. Leaving the
       * replay allowlist is not a policy question: the list is computed rather
       * than confirmed, so leaving it means the application changed.
       */
      function enforceResolvedUrl(stepId: string): void {
        const current = page.url();
        if (current === 'about:blank') {
          return;
        }

        const decision = checkAllowlist(current, [...allowed]);
        if (decision.allowed) {
          return;
        }

        const recorded = redactUrl(current, policy);

        record(
          {
            kind: 'error',
            category: 'hard-failure',
            expected: `a navigation within ${[...allowed].join(', ') || '(no hosts)'}`,
            observed: recorded,
          },
          stepId,
        );
        record({ kind: 'run.finished', status: { ending: 'failure', category: 'hard-failure' } });

        throw new NavigationBlocked(`${stepId}: navigation resolved outside the allowlist`, {
          runId,
          step: stepId,
          expected: `a navigation within ${[...allowed].join(', ') || '(no hosts)'}`,
          observed: `${recorded} (${decision.reason})`,
        });
      }

      // ---- pause and resume -----------------------------------------------

      /**
       * Wait for a surface, with a bound. Resolved by polling, so nobody is asked.
       *
       * Its expiry is returned as an ordinary step failure rather than thrown, so
       * it goes round the verification ladder — retry, then the declared
       * detectors, then a hard failure. That is deliberate: a screen that never
       * arrived is exactly the condition an outcome detector may legitimately
       * explain, and "no such account" reaching the caller as a timeout would be
       * the taxonomy inverted.
       */
      async function waitForSurface(
        step: PauseStep & { kind: 'pauseUntil' },
      ): Promise<StepFailure | undefined> {
        const startedAt = Date.now();
        record(
          {
            kind: 'pause',
            reason: 'awaiting-surface',
            name: step.id,
            declared: true,
            expiresAt: new Date(clock().getTime() + step.withinMs).toISOString(),
          },
          step.id,
        );

        const resolution = await resolveTarget(page, step.target, 'present', step.withinMs);
        if (!resolution.found) {
          return {
            expected: describeChain(step.target),
            observed: `the surface did not arrive within ${String(step.withinMs)}ms`,
          };
        }

        record(
          {
            kind: 'resume',
            reason: 'awaiting-surface',
            resolvedBy: 'polling',
            waitedMs: Date.now() - startedAt,
          },
          step.id,
        );
        return undefined;
      }

      /**
       * Ask a human, or park because there is nobody to ask.
       *
       * A pause named in the flow is part of the contract, not an incident: MFA on
       * every login is expected, and a capability that declares it is attended
       * rather than broken. That is why this records `declared: true` and does not
       * escalate — only an *undeclared* pause is an escalation, and during replay
       * one cannot occur, because the DSL is the only way to stop.
       */
      async function runPause(step: PauseStep & { kind: 'pause' }): Promise<void> {
        const startedAt = Date.now();
        const reason = PAUSE_REASON[step.pauseKind];
        const expiresAt = new Date(clock().getTime() + step.withinMs).toISOString();
        const request: InteractionRequest = {
          kind: step.pauseKind,
          name: step.name,
          prompt: step.prompt,
          // Every value obtained mid-run is a secret: it has never been through
          // the field declarations, so nothing else would redact it.
          secret: step.pauseKind === 'input',
          expiresAt,
        };

        const holder = resolver === undefined ? 'caller' : 'resolver';
        const pauseEntry = record(
          { kind: 'pause', reason, name: step.name, declared: true, expiresAt },
          step.id,
        );
        await recordWithCapture(
          { kind: 'control.transferred', holder, stateBefore: where() },
          step.id,
          'control-transfer',
          page,
        );

        const response = await obtainResponse(step, request);
        const heldMs = Date.now() - startedAt;

        const check = checkResponse(step.pauseKind, response);
        if (!check.ok) {
          throw await hardFailure(
            InteractionFailed,
            step.id,
            `${step.id}: a ${step.pauseKind} answered with the wrong kind of value`,
            check.expected,
            check.observed,
          );
        }

        await recordWithCapture(
          { kind: 'control.returned', holder, heldMs, stateAfter: where() },
          step.id,
          'control-transfer',
          page,
        );
        record({ kind: 'resume', reason, resolvedBy: holder, waitedMs: heldMs }, step.id);

        switch (step.pauseKind) {
          case 'input':
            obtained[step.name] = response as Secret;
            break;

          case 'approval':
            if (response === true) {
              // The `seq` an `effect.performed` will point at. Linking them is
              // what turns the effects declaration from a claim in the contract
              // into something observable after the fact.
              approvedBySeq = pauseEntry.seq;
              break;
            }
            {
              throw await hardFailure(
                ApprovalDenied,
                step.id,
                `${step.id}: approval refused`,
                'approval for the step that follows',
                'the approver refused',
              );
            }
            break;

          case 'operator':
            break;
        }

        await reassertCheckpoint(step.id);
      }

      /** Get an answer, from the resolver or from whoever eventually resumes. */
      async function obtainResponse(
        step: PauseStep & { kind: 'pause' },
        request: InteractionRequest,
      ): Promise<InteractionResponse> {
        try {
          return resolver === undefined
            ? await session.park(request, step.withinMs)
            : await withBound(resolver(request), step.withinMs);
        } catch (error) {
          if (error instanceof PauseTimeout) {
            throw await expiry(step, error);
          }
          // A resolver that throws has failed to answer, which is not the same as
          // declining: it is a bug in the caller's policy, and treating it as a
          // deny would silently pick one of the two answers it failed to give.
          throw await hardFailure(
            InteractionFailed,
            step.id,
            `${step.id}: the resolver threw`,
            `an answer to the ${step.pauseKind} pause`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      /**
       * What an unanswered pause becomes.
       *
       * An approval that expires is treated as a **deny**, because silence is not
       * consent — so it is the same error class a refusal produces. The others are
       * a plain expiry. Either way it is a hard failure with evidence rather than a
       * hang, which is what "every pause is bounded" buys.
       */
      async function expiry(
        step: PauseStep & { kind: 'pause' },
        timeout: PauseTimeout,
      ): Promise<ReplayError> {
        const observed =
          timeout.expiredBy === 'ttl'
            ? `nobody resumed the parked run within its TTL (${String(timeout.waitedMs)}ms)`
            : `nobody answered within ${String(step.withinMs)}ms`;

        return hardFailure(
          step.pauseKind === 'approval' ? ApprovalDenied : PauseExpired,
          step.id,
          `${step.id}: ${observed}`,
          step.pauseKind === 'approval'
            ? 'an approval, since an expired approval is a deny'
            : `an answer to the ${step.pauseKind} pause`,
          observed,
        );
      }

      /**
       * Re-assert the last checkpoint that passed.
       *
       * After a human touches the session the flow cannot assume where it is, so
       * resume validates a known state before continuing; a mismatch is a hard
       * failure, not a blind continuation. A pause with no checkpoint behind it
       * re-asserts nothing, because there is no known state to return to.
       */
      async function reassertCheckpoint(stepId: string): Promise<void> {
        const checkpoint = lastCheckpoint;
        if (checkpoint === undefined) {
          return;
        }

        const resolution = await resolveTarget(page, checkpoint.target, 'present', timeoutMs);
        if (!resolution.found) {
          record({ kind: 'checkpoint', satisfied: false }, checkpoint.id);
          throw await hardFailure(
            CheckpointFailed,
            stepId,
            `${stepId}: the session did not come back where it was left`,
            `${checkpoint.id} to still hold: ${describeChain(checkpoint.target)}`,
            'the page is no longer the one the flow paused on',
          );
        }

        record({ kind: 'checkpoint', satisfied: true }, checkpoint.id);
      }

      /** Where the browser is, for control-transfer evidence. */
      function where(): string {
        try {
          return redactUrl(page.url(), policy);
        } catch {
          // The context is gone — a TTL killed it. Its absence is the evidence.
          return '(session closed)';
        }
      }

      /**
       * Record the verdict and build the error, so the two cannot disagree.
       *
       * Every hard failure comes through here, which is what makes "attachments
       * on triggers only" a property rather than a convention — there is one
       * place a failure is written, so there is one place capture can happen and
       * one place it can be forgotten.
       */
      async function hardFailure(
        Class: new (message: string, detail: ReplayErrorDetail) => ReplayError,
        stepId: string,
        message: string,
        expected: string,
        observed: string,
      ): Promise<ReplayError> {
        await recordWithCapture(
          { kind: 'error', category: 'hard-failure', expected, observed },
          stepId,
          'hard-failure',
          page,
        );
        record({ kind: 'run.finished', status: { ending: 'failure', category: 'hard-failure' } });
        return new Class(message, { runId, step: stepId, expected, observed });
      }

      /**
       * Whether each declared detector matches, in declaration order.
       *
       * A detector is a predicate, so several matches is not ambiguity: "is 'No
       * such account' on this page" has one answer whether the phrase appears in a
       * heading, a banner, or both.
       */
      async function evaluateDetectors(
        outcomes: readonly OutcomeDeclaration[],
      ): Promise<boolean[]> {
        const matched: boolean[] = [];
        for (const outcome of outcomes) {
          const resolution = await resolveTarget(page, outcome.detector, 'present', 0);
          matched.push(resolution.found);
        }
        return matched;
      }
    } catch (error) {
      if (!(error instanceof ReplayError) && !(error instanceof Terminated)) {
        record({
          kind: 'error',
          category: 'hard-failure',
          expected: 'the flow to run to completion',
          observed: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      await context?.close().catch(() => undefined);
      if (ownsBrowser) {
        await openBrowser.close().catch(() => undefined);
      }
    }
  }
}

/**
 * Bound a resolver's answer.
 *
 * `Promise.race` attaches a handler to the resolver's promise, so a resolver
 * that rejects after the bound has already elapsed is handled rather than
 * surfacing as an unhandled rejection.
 */
async function withBound<T>(work: Promise<T>, boundMs: number): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new PauseTimeout('bound', Date.now() - startedAt));
        }, boundMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function describeAnswer(answer: unknown): string {
  if (typeof answer === 'object' && answer !== null && 'status' in answer) {
    return String(answer.status);
  }
  return 'outcome';
}
