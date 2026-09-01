/**
 * `@interfacer/dsl` — the notation a flow is written in, and the engine that
 * executes it.
 *
 * This package knows nothing about Interfacer, the agent loop, or any model. It
 * is the only component a generated capability needs at run time, which is why a
 * capability in production never loads an SDK and never needs an API key.
 *
 * Phases 1 and 3 through 6 land the contract, the pure primitives, the `Flow`
 * builder, the execution engine, pause and parked runs, the evidence rules —
 * record destinations, attachments on triggers, and what `dataClasses` permits
 * either of them to carry — and replay-time enforcement of the `effects`
 * dimensions that drive one.
 *
 * Still to come: everything above the DSL — the generator, the agent loop and
 * the CLI.
 */

export { isSecret, makeSecret, REDACTED, type Secret } from './secret.js';

export {
  answer,
  asMoney,
  asNumber,
  asText,
  checkAnswerSources,
  describes,
  extracted,
  field,
  join,
  literal,
  obtained,
  type Described,
  type FillAccessor,
  type ValueSource,
} from './accessors.js';

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
  capture,
  type AttachmentKind,
  type AttachmentRef,
  type AttachmentTrigger,
  type CaptureRequest,
} from './attachments.js';

export {
  DEFAULT_EFFECTS,
  evidencePolicyFor,
  redactUrl,
  STRUCTURAL_ATTRIBUTES,
  VALUE_BEARING,
  type DataClass,
  type Effects,
  type EvidencePolicy,
  type External,
  type Financial,
  type Mutates,
  type Reversible,
  type Scope,
  type SecurityEffect,
} from './effects.js';

export {
  createEmitter,
  createEntryFactory,
  DEFAULT_DESTINATION,
  type Entry,
  type EntryBody,
  type EntryEvidence,
  type EntryFactory,
  type EntryFactoryOptions,
  type EntryKind,
  type Envelope,
  type ErrorCategory,
  type PauseReason,
  type Phase,
  type RecordDestination,
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
  EffectsRefused,
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

export {
  checkSafety,
  requiresApproval,
  type SafetyConditions,
  type SafetyRule,
  type SafetySubject,
  type SafetyViolation,
} from './safety.js';

export { isDrift, resolveTarget, type Arity, type Resolution } from './resolve.js';

export {
  answerSchema,
  answerShapes,
  inputSchema,
  type AnswerShape,
  type JsonSchema,
} from './schema.js';

export { runFlow, type RunOptions } from './engine.js';
