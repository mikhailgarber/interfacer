/**
 * Parked runs.
 *
 * Most runs never park. The CLI, and any library caller that supplies a
 * resolver, answer the pause in place and carry on within the same call —
 * nothing is stored and there is no session to speak of. A run parks only where
 * there is nowhere to ask: a library caller that deliberately omits a resolver,
 * and MCP, where a tool cannot call back into its caller mid-execution.
 *
 * A parked run is held in memory beside its browser handle, in a plain
 * `Map<sessionId, ParkedRun>` owned by the process running the browser. None of
 * this is a service: no store, no database, no queue, no cross-host addressing.
 * The run's state *is* a live browser process rather than a serializable record,
 * so `sessionId` is a handle to that process, not a key anyone else could look
 * up — it is resumable only from the process that parked it.
 *
 * Two rules stop it leaking. Every parked run has a TTL, and expiry kills the
 * browser and marks the run a hard failure with evidence, so a forgotten session
 * cannot strand a browser process. And `resume` is single-shot: a second call on
 * the same id is an error.
 *
 * Deliberate cut: parked runs die with the process. A live browser cannot be
 * restored mid-flow, so recovery after a crash means re-running from step 0 with
 * restored storage state — re-execution, not resume.
 */
import { UnknownSession } from './errors.js';
import type { InteractionRequest, InteractionResponse, Suspended } from './pause.js';

/** Why a pause stopped waiting. Internal; the engine turns it into a `ReplayError`. */
export class PauseTimeout extends Error {
  /**
   * `bound` — the pause's own `within` elapsed. `ttl` — the parked run outlived
   * what the process holding the browser will tolerate, which is a different
   * fact and gets said differently in the record.
   *
   * Not spelled `cause`: `Error` already owns that name, and narrowing an
   * inherited member to mean something else is how a stack trace stops saying
   * what it meant.
   */
  readonly expiredBy: 'bound' | 'ttl';
  readonly waitedMs: number;

  constructor(expiredBy: 'bound' | 'ttl', waitedMs: number) {
    super(`pause expired (${expiredBy})`);
    this.name = new.target.name;
    this.expiredBy = expiredBy;
    this.waitedMs = waitedMs;
  }
}

interface Pending<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The registry. One map, module-level, because it is owned by the process that
 * holds the browsers — not by a run, and not by anything addressable from
 * outside it.
 */
const PARKED = new Map<string, RunSession>();

/** How many runs are parked right now. Exists so a test can prove one is not leaked. */
export function parkedCount(): number {
  return PARKED.size;
}

export interface SessionOptions {
  /** How long a parked run may sit before it is killed. */
  readonly ttlMs: number;
  /**
   * Close the browser and its context. Called on TTL expiry, because the run is
   * over and its browser is what would otherwise be stranded.
   */
  readonly dispose: () => Promise<void>;
  readonly newSessionId?: () => string;
}

/**
 * One run's suspension state.
 *
 * The run itself is an ordinary `async` function that stays alive across a park:
 * parking is an `await` inside it, so there is no state machine to rebuild and
 * no step index to trust. What moves is only *who is holding the promise* — the
 * original caller until the first park, then whoever called `resume`.
 */
export class RunSession {
  readonly #ttlMs: number;
  readonly #dispose: () => Promise<void>;
  readonly #newSessionId: () => string;

  /** Whoever is currently awaiting this run's next settlement. */
  #waiter: Pending<unknown>;
  /** The paused step, awaiting an answer. Absent while the run is executing. */
  #park: Pending<InteractionResponse> | undefined;
  #sessionId: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SessionOptions) {
    this.#ttlMs = options.ttlMs;
    this.#dispose = options.dispose;
    this.#newSessionId =
      options.newSessionId ??
      ((): string => `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    this.#waiter = this.#newWaiter();
  }

  /** The promise the current holder is awaiting. */
  get settlement(): Promise<unknown> {
    return this.#waiter.promise;
  }

  #newWaiter(): Pending<unknown> {
    const waiter = pending<unknown>();
    // A waiter installed at park time may reject — on TTL expiry — before anyone
    // calls `resume` to take hold of it. Attaching a handler here keeps that from
    // surfacing as an unhandled rejection; `resume` still gets the rejection,
    // because a second handler does not consume the first.
    void waiter.promise.catch(() => undefined);
    return waiter;
  }

  /**
   * Suspend, hand a {@link Suspended} to whoever is waiting, and wait to be
   * resumed.
   *
   * The deadline is the tighter of the pause's own bound and the parked-run TTL.
   * They answer different questions — how long the flow said it would wait,
   * versus how long this process will hold a browser for an answer that may
   * never come — so which one elapsed is recorded rather than collapsed.
   */
  async park(request: InteractionRequest, boundMs: number): Promise<InteractionResponse> {
    const sessionId = this.#newSessionId();
    const park = pending<InteractionResponse>();

    this.#sessionId = sessionId;
    this.#park = park;
    PARKED.set(sessionId, this);

    const deadlineMs = Math.min(boundMs, this.#ttlMs);
    const cause = this.#ttlMs < boundMs ? 'ttl' : 'bound';
    const startedAt = Date.now();

    this.#timer = setTimeout(() => {
      PARKED.delete(sessionId);
      this.#park = undefined;
      // The browser dies with the expiry, not with the eventual rejection: a
      // forgotten session must not strand a browser process even if nobody is
      // left holding the promise that reports it.
      void this.#dispose().finally(() => {
        park.reject(new PauseTimeout(cause, Date.now() - startedAt));
      });
    }, deadlineMs);

    const suspended: Suspended = { status: 'suspended', sessionId, request };
    const waiter = this.#waiter;
    this.#waiter = this.#newWaiter();
    waiter.resolve(suspended);

    return park.promise;
  }

  /** @internal — {@link resume} is the public door. */
  deliver(response: InteractionResponse): Promise<unknown> {
    const park = this.#park;
    if (park === undefined) {
      // An invariant check rather than a reachable path: the registry entry and
      // `#park` are set and cleared together, so `resume`'s lookup has already
      // refused anything that would land here. It stays because the two moving
      // together is the thing that makes single-shot true, and a future edit
      // that separated them should fail loudly rather than resolve a dead park.
      throw new UnknownSession(this.#sessionId ?? '(unknown)');
    }

    this.#clearTimer();
    this.#park = undefined;
    // Single-shot: the id is gone before the run has even woken up, so a second
    // `resume` cannot race the first into the same paused step.
    if (this.#sessionId !== undefined) {
      PARKED.delete(this.#sessionId);
    }

    const settlement = this.#waiter.promise;
    park.resolve(response);
    return settlement;
  }

  /** The run finished. Hand the answer to whoever is holding the promise. */
  settle(answer: unknown): void {
    this.#clearTimer();
    this.#forget();
    this.#waiter.resolve(answer);
  }

  /** The run threw. */
  fail(error: unknown): void {
    this.#clearTimer();
    this.#forget();
    this.#waiter.reject(error);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #forget(): void {
    if (this.#sessionId !== undefined) {
      PARKED.delete(this.#sessionId);
      this.#sessionId = undefined;
    }
    this.#park = undefined;
  }
}

/**
 * Answer a parked run and let it continue.
 *
 * Resolves with the run's next settlement: its answer, or another
 * {@link Suspended} if the flow pauses again. Rejects with the run's hard
 * failure, exactly as the original call would have.
 *
 * Single-shot. A second call on the same id is an {@link UnknownSession}, and so
 * is an id whose run has finished, expired, or never existed here — parked runs
 * are handles to a live browser in *this* process, not keys anyone else can look
 * up.
 */
export async function resume(sessionId: string, response: InteractionResponse): Promise<unknown> {
  const session = PARKED.get(sessionId);
  if (session === undefined) {
    throw new UnknownSession(sessionId);
  }
  return session.deliver(response);
}
