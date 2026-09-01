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

/** The interview's inputs as the declaration the generated project exports. */
export function fieldsFor(contract: Contract): FieldSet {
  const declared: Record<string, Field> = {};
  for (const input of contract.inputs) {
    const make = MAKERS[input.kind];
    declared[input.name] = make(
      input.description === undefined ? {} : { description: input.description },
    );
  }
  return fields(declared);
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

/**
 * Where live values live: an empty record the model fills as it asks for them.
 *
 * The engine reads an input at the moment a step needs it, so a value bound
 * mid-run is visible to every step after it. It is held for the life of the run
 * and written nowhere — not into the project, not into the record — which is
 * what makes the artifact parameterized by construction.
 */
export function liveValues(): Record<string, unknown> {
  return {};
}
