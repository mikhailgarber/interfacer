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
 * This module carries entry construction and where the finished entries go.
 * What may be *in* them — attachments, and how `dataClasses` bounds them — lives
 * in `effects.ts` and `attachments.ts`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DenialReason, HostPattern } from './allowlist.js';
import type { AttachmentRef } from './attachments.js';
import type { Usage } from './cost.js';
import type { DataClass } from './effects.js';
import type { Strategy } from './target.js';

/**
 * Which part of a session an entry came from.
 *
 * The interview drives nothing — there is no browser and no flow yet — so it
 * contributes no step, navigation or attachment. What it contributes is the
 * account of how the contract those steps answer to was settled.
 */
export type Phase = 'discovery' | 'replay' | 'interview';

/** What every entry in one run carries in common. */
export interface RunContext {
  readonly runId: string;
  readonly capabilityId: string;
  /**
   * The `package.json` version. One project is one capability.
   *
   * Absent only in the interview, which precedes the project whose
   * `package.json` would supply it — and absent rather than blank, because a
   * version nobody assigned would read as one somebody did. A rerun against an
   * existing project has one, and carries it.
   */
  readonly capabilityVersion?: string;
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
  /**
   * Screenshots and DOM snapshots are attachments **on an entry**, not a second
   * artifact — there is no separate trace to correlate against. Referenced by
   * path rather than inlined, so the record stays a stream of one-line entries.
   */
  readonly attachments?: readonly AttachmentRef[];
  /**
   * Why a trigger produced no attachments.
   *
   * Present rather than absent, because rich capture that silently did not
   * happen leaves a reader believing they are looking at everything there was.
   */
  readonly attachmentsSkipped?: string;
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
      /**
       * What the capability declared it observes, and whether it declared at
       * all. A capability that declares nothing is treated permissively, so the
       * absence has to be visible — otherwise a reader cannot tell a considered
       * `non-identifying` from a forgotten declaration.
       */
      readonly dataClasses: readonly DataClass[];
      readonly effectsDeclared: boolean;
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
  /**
   * What a turn of the interview settled, and what admitted it.
   *
   * The fields, never the prose. Content everywhere else in this record passes
   * through `dataClasses`, and the interview is the phase that has not yet
   * declared what data it may handle — so a person's answers would be the one
   * thing written under no policy at all. They are not lost either way: the
   * settled contract is emitted as source into the project.
   */
  | {
      readonly kind: 'answer.recorded';
      readonly fields: readonly string[];
      /** A person in the session, or a sentence quoted from the interview file. */
      readonly authority: 'human' | 'file';
    }
  /**
   * A guardrail Interfacer proposed, and whether it was accepted.
   *
   * What makes "a human authored the guardrails" checkable after the fact: not
   * the sentence somebody typed, but that the allowlist was accepted by a
   * person at a known point in the session.
   */
  | { readonly kind: 'proposal.put'; readonly field: string; readonly accepted: boolean }
  /**
   * A declared outcome whose state was reached, but which nothing detected.
   *
   * Beside `outcome.matched` because it is the same moment with the opposite
   * result, and it is the moment a person inherits the work: no detector can be
   * recorded, so the arm has to be written by hand against the screen this
   * entry carries.
   */
  | { readonly kind: 'outcome.undetected'; readonly status: string }
  | { readonly kind: 'retry'; readonly reason: string; readonly attempt: number }
  | {
      readonly kind: 'pause';
      readonly reason: PauseReason;
      readonly name?: string;
      /**
       * A pause named in the flow is part of the contract, not an incident: MFA
       * on every login is expected, and a capability that declares it is simply
       * attended rather than broken. Only an undeclared pause is an escalation,
       * which during replay cannot happen — the DSL is the only way to pause.
       */
      readonly declared: boolean;
      /** ISO-8601. Every pause is bounded, and this is the bound. */
      readonly expiresAt: string;
    }
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
/** The envelope fields a trigger contributes. Never part of the body. */
export interface EntryEvidence {
  readonly attachments?: readonly AttachmentRef[];
  readonly attachmentsSkipped?: string;
}

export interface EntryFactory {
  /** The `seq` the next entry will carry. */
  readonly nextSeq: number;
  /** Stamp an envelope onto a body. `stepId` is omitted where it does not apply. */
  entry(body: EntryBody, stepId?: string, evidence?: EntryEvidence): Entry;
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

    entry(body: EntryBody, stepId?: string, evidence: EntryEvidence = {}): Entry {
      const envelope: Envelope = {
        runId: context.runId,
        capabilityId: context.capabilityId,
        ...(context.capabilityVersion === undefined
          ? {}
          : { capabilityVersion: context.capabilityVersion }),
        phase: context.phase,
        seq: seq++,
        timestamp: now().toISOString(),
        ...(stepId === undefined ? {} : { stepId }),
        ...(evidence.attachments === undefined ? {} : { attachments: evidence.attachments }),
        ...(evidence.attachmentsSkipped === undefined
          ? {}
          : { attachmentsSkipped: evidence.attachmentsSkipped }),
      };

      return Object.freeze({ ...envelope, ...body });
    },
  };
}

/**
 * Where the record goes.
 *
 * The record is a log and is configured like one: one JSON object per line, to
 * **stdout by default**, so a run is pipeable and needs no path convention at
 * all.
 *
 * One case is not a preference but a constraint. An MCP server's stdout is the
 * protocol transport, so the record must never go there — `'stderr'` or a file
 * is what an MCP entry point selects, and writing entries onto the transport
 * would corrupt the protocol rather than merely being untidy.
 */
export type RecordDestination = 'stdout' | 'stderr' | { readonly file: string };

export const DEFAULT_DESTINATION: RecordDestination = 'stdout';

/** One JSON object per line, to wherever the destination names. */
export function createEmitter(destination: RecordDestination): (entry: Entry) => void {
  if (destination === 'stdout') {
    return (entry) => void process.stdout.write(`${JSON.stringify(entry)}\n`);
  }

  if (destination === 'stderr') {
    return (entry) => void process.stderr.write(`${JSON.stringify(entry)}\n`);
  }

  const { file } = destination;
  mkdirSync(dirname(file), { recursive: true });
  // Appended synchronously: the record is an append-only log whose ordering is
  // the point, and a stream would need an open/close lifecycle the engine does
  // not own — a run that throws must still leave the entries it had written.
  return (entry) => {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  };
}
