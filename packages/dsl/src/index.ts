/**
 * `@interfacer/dsl` — the notation a flow is written in, and the engine that
 * executes it.
 *
 * This package knows nothing about Interfacer, the agent loop, or any model. It
 * is the only component a generated capability needs at run time, which is why a
 * capability in production never loads an SDK and never needs an API key.
 *
 * Phase 1 lands the contract and the pure primitives. Still to come:
 *
 * - **Phase 3** — the `Flow` builder and the execution engine.
 * - **Phase 4** — the pause primitives, `Resolver`, and parked runs.
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
