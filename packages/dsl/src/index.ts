/**
 * `@interfacer/dsl` — the notation a flow is written in, and the engine that
 * executes it.
 *
 * This package knows nothing about Interfacer, the agent loop, or any model. It
 * is the only component a generated capability needs at run time, which is why a
 * capability in production never loads an SDK and never needs an API key.
 *
 * Phases 1, 3 and 4 land the contract, the pure primitives, the `Flow` builder,
 * the execution engine, the pause primitives and parked runs. Still to come:
 *
 * - **Phase 5** — record emission, attachments, and `dataClasses`.
 */

export { isSecret, makeSecret, REDACTED, type Secret } from './secret.js';

export {
  boolean,
  fieldNames,
  fields,
  number,
  secret,
  secretFieldNames,
  text,
  type Field,
  type FieldKind,
  type FieldOptions,
  type FieldSet,
  type Infer,
  type ValueOf,
} from './fields.js';

export {
  byLabel,
  byRole,
  byText,
  css,
  describeTarget,
  isBestFirst,
  namesOf,
  strategyRank,
  STRATEGY_PREFERENCE,
  type AccessibleName,
  type Strategy,
  type Target,
  type TargetChain,
} from './target.js';

export {
  checkAllowlist,
  type AllowlistDecision,
  type DenialReason,
  type HostPattern,
} from './allowlist.js';

export {
  addUsage,
  costOf,
  KNOWN_MODEL_RATES,
  ratesFor,
  spendCost,
  ZERO_SPEND,
  type ModelRates,
  type Spend,
  type Usage,
} from './cost.js';

export {
  createEntryFactory,
  type Entry,
  type EntryBody,
  type EntryFactory,
  type EntryFactoryOptions,
  type EntryKind,
  type Envelope,
  type ErrorCategory,
  type PauseReason,
  type Phase,
  type RunContext,
  type TerminalStatus,
  type VariantStamp,
} from './record.js';

export {
  decideVerification,
  type Recovery,
  type VerificationDecision,
  type VerificationInput,
} from './verification.js';

export {
  ApprovalDenied,
  CheckpointFailed,
  InteractionFailed,
  isReplayError,
  NavigationBlocked,
  PauseExpired,
  ReplayError,
  SessionExpired,
  SurfaceUnavailable,
  TargetAmbiguous,
  UnknownSession,
  type ReplayErrorDetail,
} from './errors.js';

export {
  checkResponse,
  DEFAULT_INTERACTION_BOUND_MS,
  DEFAULT_PARK_TTL_MS,
  DEFAULT_SURFACE_BOUND_MS,
  isSuspended,
  parseDuration,
  type Duration,
  type InteractionDeclaration,
  type InteractionRequest,
  type InteractionResponse,
  type PauseCheck,
  type PauseKind,
  type Resolver,
  type Suspended,
} from './pause.js';

export { parkedCount, resume } from './session.js';

export {
  Branch,
  Flow,
  interactionsOf,
  isAttended,
  type Accessor,
  type ActionStep,
  type AnswerOf,
  type FillValue,
  type FlowOptions,
  type InputOf,
  type OutcomeDeclaration,
  type PauseForInputOptions,
  type PauseOptions,
  type PauseStep,
  type PauseUntilOptions,
  type Step,
  type StepOptions,
} from './flow.js';

export { isDrift, resolveTarget, type Arity, type Resolution } from './resolve.js';

export { runFlow, type RunOptions } from './engine.js';
