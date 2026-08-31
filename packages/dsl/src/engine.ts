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
import { chromium, type Browser, type BrowserContext, type Request, type Route } from 'playwright';

import { checkAllowlist, type HostPattern } from './allowlist.js';
import {
  CheckpointFailed,
  NavigationBlocked,
  ReplayError,
  SurfaceUnavailable,
  TargetAmbiguous,
} from './errors.js';
import type { FieldSet, Infer } from './fields.js';
import type { ActionStep, FillValue, Flow, OutcomeDeclaration, Step } from './flow.js';
import { createEntryFactory, type Entry, type EntryBody, type Phase } from './record.js';
import { isDrift, resolveTarget, type Resolution } from './resolve.js';
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
  /** Where the run record goes. Defaults to one JSON object per line on stdout. */
  readonly record?: (entry: Entry) => void;
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
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_RETRIES = 1;

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

export async function runFlow<I extends FieldSet, A>(
  flow: Flow<I, A>,
  input: Infer<I>,
  options: RunOptions = {},
): Promise<A> {
  const runId =
    options.runId ?? `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const emit =
    options.record ??
    ((entry: Entry): void => void process.stdout.write(`${JSON.stringify(entry)}\n`));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;

  const entries = createEntryFactory(
    {
      runId,
      capabilityId: flow.id,
      capabilityVersion: options.capabilityVersion ?? '0.0.0',
      phase: options.phase ?? 'replay',
    },
    options.now === undefined ? {} : { now: options.now },
  );

  const record = (body: EntryBody, stepId?: string): Entry => {
    const entry = entries.entry(body, stepId);
    emit(entry);
    return entry;
  };

  const ownsBrowser = options.browser === undefined;
  const browser =
    options.browser ?? (await chromium.launch({ headless: options.headless ?? true }));

  // Origins the caller is entitled to reach. The entry point's own origin is
  // added when `.open()` resolves it: the caller chose where to point the
  // capability, so the allowlist is not there to second-guess that — it bounds
  // everywhere *else* the automation could be taken.
  const allowed = new Set<HostPattern>(options.allowlist ?? flow.declaredAllowlist);

  let context: BrowserContext | undefined;
  let blocked: { url: string; reason: string } | undefined;

  try {
    context = await browser.newContext();
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
        url: request.url(),
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
    });

    const extracted: Record<string, unknown> = {};

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
            throw new Terminated((declaration.map as (value: Infer<I>) => unknown)(input));
          }

          case 'proceed':
          case 'fail':
            break;
        }

        record(
          {
            kind: 'error',
            category: 'hard-failure',
            expected: failure.expected,
            observed: failure.observed,
          },
          step.id,
        );
        record({ kind: 'run.finished', status: { ending: 'failure', category: 'hard-failure' } });

        throw blocked === undefined
          ? new CheckpointFailed(`${step.id}: ${failure.observed}`, {
              runId,
              step: step.id,
              expected: failure.expected,
              observed: failure.observed,
            })
          : new NavigationBlocked(`${step.id}: navigation left the allowlist`, {
              runId,
              step: step.id,
              expected: `a navigation within ${[...allowed].join(', ') || '(no hosts)'}`,
              observed: `${blocked.url} (${blocked.reason})`,
            });
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
    async function attemptStep(step: Step): Promise<StepFailure | undefined> {
      if (step.kind === 'open') {
        return openEntryPoint(step.url as unknown as (value: Infer<I>) => string, step.id);
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
          record(
            {
              kind: 'error',
              category: 'hard-failure',
              expected: 'exactly one element',
              observed: `${String(resolution.matches)} matched ${resolution.strategy}`,
            },
            step.id,
          );
          record({ kind: 'run.finished', status: { ending: 'failure', category: 'hard-failure' } });
          throw new TargetAmbiguous(`${step.id}: ${String(resolution.matches)} elements matched`, {
            runId,
            step: step.id,
            expected: `exactly one element for ${describeChain(chain)}`,
            observed: `${String(resolution.matches)} elements matched strategy "${resolution.strategy}"`,
          });
        }
        return {
          expected: describeChain(chain),
          observed: 'no strategy in the chain resolved',
        };
      }

      return act(step, resolution);
    }

    async function act(
      step: Exclude<Step, { kind: 'open' } | { kind: 'optional' } | { kind: 'oneOf' }>,
      resolution: Resolution & { found: true },
    ): Promise<StepFailure | undefined> {
      try {
        switch (step.kind) {
          case 'fillForm': {
            const raw = (step.value as (value: Infer<I>) => FillValue)(input);
            // A secret reaches the page only through an explicit `.reveal()`,
            // and this is the one place in the codebase that call is made.
            const value = typeof raw === 'string' ? raw : raw.reveal();
            await resolution.locator.fill(value, { timeout: timeoutMs });
            break;
          }

          case 'pressButton':
          case 'commit':
            await resolution.locator.click({ timeout: timeoutMs });
            await settle();
            enforceResolvedUrl(step.id);
            break;

          case 'choose': {
            const value = (step.value as unknown as (value: Infer<I>) => string)(input);
            await resolution.locator.selectOption(value, { timeout: timeoutMs });
            break;
          }

          case 'checkpoint':
            record({ kind: 'checkpoint', satisfied: true }, step.id);
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
          observed: error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : 'failed',
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
      accessor: (value: Infer<I>) => string,
      stepId: string,
    ): Promise<StepFailure | undefined> {
      const url = accessor(input);

      try {
        allowed.add(new URL(url).hostname);
      } catch {
        return { expected: 'a URL', observed: url };
      }

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs * 3 });
      } catch (error) {
        if (blocked !== undefined) {
          return { expected: 'a navigation within the allowlist', observed: blocked.url };
        }
        throw new SurfaceUnavailable(`${stepId}: could not reach ${url}`, {
          runId,
          step: stepId,
          expected: `a page at ${url}`,
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

      record(
        {
          kind: 'error',
          category: 'hard-failure',
          expected: `a navigation within ${[...allowed].join(', ') || '(no hosts)'}`,
          observed: current,
        },
        stepId,
      );
      record({ kind: 'run.finished', status: { ending: 'failure', category: 'hard-failure' } });

      throw new NavigationBlocked(`${stepId}: navigation resolved outside the allowlist`, {
        runId,
        step: stepId,
        expected: `a navigation within ${[...allowed].join(', ') || '(no hosts)'}`,
        observed: `${current} (${decision.reason})`,
      });
    }

    /**
     * Whether each declared detector matches, in declaration order.
     *
     * A detector is a predicate, so several matches is not ambiguity: "is 'No
     * such account' on this page" has one answer whether the phrase appears in a
     * heading, a banner, or both.
     */
    async function evaluateDetectors(outcomes: readonly OutcomeDeclaration[]): Promise<boolean[]> {
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
    await context?.close();
    if (ownsBrowser) {
      await browser.close();
    }
  }
}

function describeAnswer(answer: unknown): string {
  if (typeof answer === 'object' && answer !== null && 'status' in answer) {
    return String(answer.status);
  }
  return 'outcome';
}
