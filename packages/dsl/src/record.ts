/**
 * The run record: evidence is exactly one thing, an append-only log, one per
 * run. Screenshots and DOM snapshots are attachments on an entry, not a second
 * artifact — there is no separate trace, log, or transcript to correlate
 * against.
 *
 * Both phases produce the same record. Discovery adds entry kinds replay has no
 * use for, but the format is one format, so a run that was recorded and a run
 * that replayed are read side by side.
 *
 * This module is entry *construction* only. Emission, destinations and
 * attachments are Phase 5.
 */
import type { DenialReason, HostPattern } from './allowlist.js';
import type { Usage } from './cost.js';
import type { Strategy } from './target.js';

export type Phase = 'discovery' | 'replay';

/** What every entry in one run carries in common. */
export interface RunContext {
  readonly runId: string;
  readonly capabilityId: string;
  /** The `package.json` version. One project is one capability. */
  readonly capabilityVersion: string;
  readonly phase: Phase;
}

export interface Envelope extends RunContext {
  /**
   * Position in the record. Entries reference each other by it — an
   * `effect.performed` names the `pause` that approved it — which is what turns
   * the effects declarations from a claim in the contract into something
   * observable after the fact.
   */
  readonly seq: number;
  /** ISO-8601. */
  readonly timestamp: string;
  /** Absent on entries that are about the run rather than a step. */
  readonly stepId?: string;
}

/**
 * What Interfacer recorded the artifact against.
 *
 * Emitted at `run.started`, so every run carries the provenance of the artifact
 * that produced it. The full declaration is written by generation in Phase 10.
 */
export interface VariantStamp {
  readonly capability: string;
  readonly vendor?: string;
  readonly appVersion?: string;
  readonly recordedAgainst: string;
  readonly recordedOn: string;
}

/** A run ends exactly one of three ways. */
export type TerminalStatus =
  | { readonly ending: 'success' }
  | { readonly ending: 'outcome'; readonly status: string }
  | { readonly ending: 'failure'; readonly category: string };

/**
 * Errors are categorized by who needs to act on them, and each surfaces through
 * a different mechanism.
 */
export type ErrorCategory = 'business-outcome' | 'recoverable' | 'hard-failure';

export type PauseReason =
  /** Load, spinner, transient slowness. Resolved by polling. */
  | 'awaiting-surface'
  /** A value not knowable in advance — MFA, a one-time token. */
  | 'awaiting-input'
  /** A risky or irreversible step needs approval. */
  | 'awaiting-decision'
  /** A human must operate the session. */
  | 'awaiting-action';

export type EntryBody =
  | {
      readonly kind: 'run.started';
      /** Names, never values. The redaction is structural, not filtered. */
      readonly inputNames: readonly string[];
      readonly secretInputNames: readonly string[];
      readonly variant?: VariantStamp;
    }
  | { readonly kind: 'run.finished'; readonly status: TerminalStatus }
  | { readonly kind: 'step.started'; readonly verb: string }
  | {
      readonly kind: 'step.finished';
      /** Which strategy in the chain resolved the target. */
      readonly resolvedBy: Strategy;
      readonly strategyIndex: number;
      /**
       * The primary strategy failed and a weaker one carried it. The application
       * has moved from what was recorded, and the artifact survived by luck.
       */
      readonly drifted: boolean;
    }
  | {
      readonly kind: 'navigation';
      /** The resolved URL, after redirects. */
      readonly url: string;
      readonly allowed: boolean;
      readonly pattern?: HostPattern;
      readonly reason?: DenialReason;
    }
  | { readonly kind: 'checkpoint'; readonly satisfied: boolean }
  | { readonly kind: 'outcome.matched'; readonly detectorIndex: number; readonly status: string }
  | { readonly kind: 'retry'; readonly reason: string; readonly attempt: number }
  | { readonly kind: 'pause'; readonly reason: PauseReason; readonly name?: string }
  | {
      readonly kind: 'resume';
      readonly reason: PauseReason;
      readonly resolvedBy: string;
      readonly waitedMs: number;
    }
  | { readonly kind: 'control.transferred'; readonly holder: string; readonly stateBefore: string }
  | {
      readonly kind: 'control.returned';
      readonly holder: string;
      readonly heldMs: number;
      readonly stateAfter: string;
    }
  | {
      readonly kind: 'effect.performed';
      /** The declared dimension the step carries, e.g. `reversible`. */
      readonly dimension: string;
      readonly value: string;
      /**
       * The `seq` of the `pause` entry that authorized it, or `null` where none
       * was required. A missing approval where one *was* required shows here.
       */
      readonly approvedBySeq: number | null;
    }
  | {
      readonly kind: 'model.turn';
      /** Discovery only. The model's stated reason for the step. */
      readonly reason: string;
      readonly tool: string;
      readonly usage: Usage;
      readonly costUsd: number;
    }
  | {
      readonly kind: 'error';
      readonly category: ErrorCategory;
      readonly expected: string;
      readonly observed: string;
    };

export type EntryKind = EntryBody['kind'];

export type Entry = Envelope & EntryBody;

export interface EntryFactoryOptions {
  /** Injectable so a record is reproducible in a test. */
  readonly now?: () => Date;
  /** Where the sequence starts. Defaults to 0. */
  readonly startSeq?: number;
}

/**
 * Stamps envelopes onto entry bodies.
 *
 * A flow author never writes a log line: the DSL primitives are the sole
 * instrumentation point, so evidence is uniform across every capability, cannot
 * be forgotten, and stays consistent between discovery and replay.
 */
export interface EntryFactory {
  /** The `seq` the next entry will carry. */
  readonly nextSeq: number;
  /** Stamp an envelope onto a body. `stepId` is omitted where it does not apply. */
  entry(body: EntryBody, stepId?: string): Entry;
}

export function createEntryFactory(
  context: RunContext,
  options: EntryFactoryOptions = {},
): EntryFactory {
  const now = options.now ?? ((): Date => new Date());
  let seq = options.startSeq ?? 0;

  return {
    get nextSeq(): number {
      return seq;
    },

    entry(body: EntryBody, stepId?: string): Entry {
      const envelope: Envelope = {
        runId: context.runId,
        capabilityId: context.capabilityId,
        capabilityVersion: context.capabilityVersion,
        phase: context.phase,
        seq: seq++,
        timestamp: now().toISOString(),
        ...(stepId === undefined ? {} : { stepId }),
      };

      return Object.freeze({ ...envelope, ...body });
    },
  };
}
