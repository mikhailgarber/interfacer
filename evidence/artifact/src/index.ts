/**
 * The master function, and the contract around it.
 *
 * One function serves all three surfaces — the command line, an ordinary import,
 * and the MCP server — and none of them is a wrapper around another. What
 * differs between them is only how an answer, a suspension and a thrown failure
 * map onto that surface's conventions.
 */
import { readFileSync } from 'node:fs';

import {
  resume as resumeRun,
  runFlow,
  type AnswerOf,
  type InteractionDeclaration,
  type InteractionResponse,
  type Resolver,
  type RunOptions,
  type Suspended,
} from '@interfacer/dsl';

import { effects, inputFields, type Input } from './contract.js';
import { flow } from './flow.js';
import { variant } from './variant.js';

export { effects, inputFields, variant, flow };
export type { Input };

export {
  ApprovalDenied,
  CheckpointFailed,
  EffectsRefused,
  InteractionFailed,
  isReplayError,
  isSuspended,
  NavigationBlocked,
  PauseExpired,
  ReplayError,
  SessionExpired,
  SurfaceUnavailable,
  TargetAmbiguous,
  UnknownSession,
  type InteractionRequest,
  type InteractionResponse,
  type Resolver,
  type Suspended,
} from '@interfacer/dsl';

/** Every answer this capability can give: success, and each declared outcome. */
export type Answer = AnswerOf<typeof flow>;

/**
 * The pauses this capability declares, so a caller knows before invoking that it
 * will stop and ask.
 *
 * Whether it needs an attended session is not declared separately — it is
 * whether this is non-empty.
 */
export const interactions: Readonly<Record<string, InteractionDeclaration>> =
  {};

export const attended = false;

/** The capability's version is the project's. There is no second number. */
export const version: string = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  }
).version;

/** Everything a caller may decide about a run. The version and phase are ours. */
export type CallOptions = Omit<RunOptions, 'capabilityVersion' | 'phase'>;

// A resolver is supplied: the engine asks and loops internally, so the run never
// suspends and the caller never handles the arm.
export function balanceLookup(
  input: Input,
  options: CallOptions & { readonly resolver: Resolver },
): Promise<Answer>;
// No resolver: there is nowhere to ask, so the run parks and says so.
export function balanceLookup(
  input: Input,
  options?: CallOptions,
): Promise<Answer | Suspended>;
export function balanceLookup(
  input: Input,
  options: CallOptions = {},
): Promise<Answer | Suspended> {
  return runFlow(flow, input, { ...options, capabilityVersion: version });
}

/** Answer a parked run. Single-shot: a second call on the same id is an error. */
export function resume(
  sessionId: string,
  response: InteractionResponse,
): Promise<Answer | Suspended> {
  return resumeRun(sessionId, response) as Promise<Answer | Suspended>;
}
