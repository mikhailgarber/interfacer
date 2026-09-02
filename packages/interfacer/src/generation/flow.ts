/**
 * The contract, turned into the flow discovery grows.
 *
 * Generation starts from an empty `Flow` carrying what the interview settled —
 * the inputs as a `fields()` declaration, the confirmed effects and allowlist,
 * and the capability id that will name the master function. Every step comes
 * from the model doing the task; nothing here is a step.
 */
import {
  boolean,
  fields,
  Flow,
  number,
  secret,
  text,
  type Field,
  type FieldKind,
  type FieldSet,
} from '@interfacer/dsl';

import type { Contract } from '../interview/contract.js';

const MAKERS: Readonly<Record<FieldKind, (options: { description?: string }) => Field>> = {
  text,
  number,
  boolean,
  secret,
};

/**
 * What names the entry point where the interview did not declare one itself.
 *
 * The interview settles the entry point as its own answer rather than as one of
 * the inputs a person lists, so the contract usually arrives without it — and a
 * capability whose entry point is not an input is one artifact per tenant. The
 * design's position is the opposite: the entry point is an ordinary input, and
 * one artifact serves every tenant that differs only in where it lives.
 */
const ENTRY_POINT = 'url';

/**
 * The interview's inputs as the declaration the generated project exports.
 *
 * The entry point comes first, both because it is the first thing a flow reads
 * and because it is the field a person editing a copied project goes looking
 * for. It is added rather than asked for: the interview already has the answer,
 * and asking again is the second pass a delta exists to avoid.
 */
export function fieldsFor(contract: Contract): FieldSet {
  const declared: Record<string, Field> = {};

  if (!contract.inputs.some((input) => input.name === ENTRY_POINT)) {
    declared[ENTRY_POINT] = text({ description: 'entry point' });
  }

  for (const input of contract.inputs) {
    const make = MAKERS[input.kind];
    declared[input.name] = make(
      input.description === undefined ? {} : { description: input.description },
    );
  }
  return fields(declared);
}

/**
 * Where live values live: the record the model fills as it asks for them.
 *
 * It starts with exactly one, the entry point the interview settled, because
 * asking for an answer already given is the second pass a delta exists to
 * avoid. Everything else is a value only the person has.
 *
 * The engine reads an input at the moment a step needs it, so a value bound
 * mid-run is visible to every step after it. It is held for the life of the run
 * and written nowhere — not into the project, not into the record — which is
 * what makes the artifact parameterized by construction.
 */
export function liveValues(contract: Contract): Record<string, unknown> {
  return { [ENTRY_POINT]: contract.entryPoint };
}

/**
 * An empty flow with the contract's declarations on it.
 *
 * The allowlist is the discovery one — wider than the flow will need, because
 * the agent explores pages that will not survive into it. The replay allowlist
 * is computed from the finished flow and needs no input at all.
 */
export function flowFor(contract: Contract): Flow<FieldSet, unknown> {
  return new Flow<FieldSet, unknown>({
    id: contract.capability,
    input: fieldsFor(contract),
    effects: contract.effects,
    ...(contract.allowlist.length === 0 ? {} : { allowlist: contract.allowlist }),
  });
}
