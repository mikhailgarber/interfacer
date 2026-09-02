/**
 * The interview's tools: four, against the discovery loop's fifteen.
 *
 * The interview is a conversation rather than a drive, so the vocabulary is
 * what a conversation needs — write an answer down, put a question to the
 * person, put a guardrail to them for confirmation, and say when there is
 * nothing left to establish.
 *
 * `record` and `propose` are separate for the reason the whole phase turns on.
 * Anything the user says is an answer and goes straight in; the allowlist and
 * `securityEffect` are Interfacer's own proposals, and a proposal a model could
 * record for itself is a constraint the model authored.
 */
import { assertUsablePattern } from '@interfacer/dsl';
import type { DataClass, FieldKind, Financial, PauseKind, Scope } from '@interfacer/dsl';

import type { ToolCall, ToolDefinition } from '../agent/decide.js';
import { ToolArgumentError } from '../agent/tools.js';
import type {
  AnswerPatch,
  EffectsDraft,
  Guarded,
  InputAnswer,
  InteractionAnswer,
  OutcomeAnswer,
} from './contract.js';

function schema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRINGS = { type: 'array', items: { type: 'string' } } as const;

const ANSWERS: Record<string, unknown> = {
  capability: {
    type: 'string',
    description: 'A plain identifier naming the capability. It names the master function.',
  },
  task: { type: 'string', description: "The task, in the user's own words." },
  entryPoint: { type: 'string', description: 'The URL the task starts from.' },
  inputs: {
    type: 'array',
    description:
      'What the task takes. A credential or token is kind "secret": it is then refused on the command line and redacted in the record.',
    items: schema(
      {
        name: { type: 'string' },
        kind: { enum: ['text', 'number', 'boolean', 'secret'] },
        description: {
          type: 'string',
          description: 'What it is for. This becomes the field description a calling agent reads.',
        },
      },
      ['name', 'kind'],
    ),
  },
  output: { type: 'string', description: 'The shape a successful run returns.' },
  outcomes: {
    type: 'array',
    description:
      'What the task can legitimately end in besides success. Each becomes an arm of the result union; an outcome not declared here cannot be returned.',
    items: schema({ id: { type: 'string' }, description: { type: 'string' } }, ['id']),
  },
  interactions: {
    type: 'array',
    description:
      'Where the task must stop and ask a human. Declaring one tells a caller in advance that this capability cannot run unattended.',
    items: schema(
      {
        kind: { enum: ['input', 'approval', 'operator'] },
        name: { type: 'string' },
        prompt: { type: 'string' },
        secret: { type: 'boolean' },
      },
      ['kind', 'name', 'prompt'],
    ),
  },
  effects: {
    type: 'object',
    description: 'What the capability does. Ask the first two; propose the rest.',
    properties: {
      mutates: { enum: ['read', 'write'] },
      reversible: { enum: ['yes', 'compensable', 'no'] },
      securityEffect: { enum: ['none', 'authority-change', 'control-override'] },
      scope: { type: 'string', description: 'single, bounded(n), or unbounded' },
      external: { enum: ['none', 'notifies-customer', 'third-party'] },
      financial: { type: 'string', description: 'none, or moves-funds(limit)' },
      idempotent: { type: 'boolean' },
      dataClasses: {
        type: 'array',
        items: { enum: ['non-identifying', 'PII', 'full-PAN', 'SSN'] },
      },
    },
    additionalProperties: false,
  },
  allowlist: { ...STRINGS, description: 'Concrete hosts, or a single leading *. for subdomains.' },
  budgetUsd: { type: 'number', description: 'A cost ceiling for discovery, in dollars.' },
  citation: {
    type: 'string',
    description:
      'Where the interview file states the allowlist or securityEffect in this patch, quoted. Checked against the file; without it those two are dropped.',
  },
};

export const INTERVIEW_TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'record',
    description:
      'Write down what has been established. Send only what this turn settled; earlier answers stand.',
    inputSchema: schema(ANSWERS, []),
  },
  {
    name: 'propose',
    description:
      'Put a guardrail to the user for confirmation. These two are proposed rather than asked, so they are recorded only once a person accepts them — or, unattended, only where the interview file states them.',
    inputSchema: schema(
      {
        field: { enum: ['allowlist', 'securityEffect'] },
        value: { oneOf: [{ type: 'string' }, STRINGS] },
        why: { type: 'string', description: 'What this rests on, in one line.' },
      },
      ['field', 'value'],
    ),
  },
  {
    name: 'ask',
    description: 'Put a question to the user. One at a time, in their words rather than in schema.',
    inputSchema: schema({ question: { type: 'string' } }, ['question']),
  },
  {
    name: 'settled',
    description: 'Nothing further to establish. Call it when every answer is in.',
    inputSchema: schema({}, []),
  },
]);

export const INTERVIEW_TOOL_NAMES: ReadonlySet<string> = new Set(
  INTERVIEW_TOOLS.map((tool) => tool.name),
);

/** A guardrail proposal, as the model made it. */
export interface Proposal {
  readonly field: Guarded;
  readonly value: string | readonly string[];
  readonly why?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolArgumentError(`${key} must be a non-empty string`);
  }
  return value;
}

function stringList(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || value.some((one) => typeof one !== 'string')) {
    throw new ToolArgumentError(`${key} must be a list of strings`);
  }
  return value as readonly string[];
}

function entries(value: unknown, key: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new ToolArgumentError(`${key} must be a list of objects`);
  }
  return value;
}

const KINDS: readonly FieldKind[] = ['text', 'number', 'boolean', 'secret'];
const PAUSES: readonly PauseKind[] = ['input', 'approval', 'operator'];
const MUTATES = ['read', 'write'] as const;
const REVERSIBLE = ['yes', 'compensable', 'no'] as const;
const SECURITY = ['none', 'authority-change', 'control-override'] as const;
const EXTERNAL = ['none', 'notifies-customer', 'third-party'] as const;
const DATA_CLASSES = ['non-identifying', 'PII', 'full-PAN', 'SSN'] as const;

/**
 * A value the model sent, checked against what the dimension admits.
 *
 * Validated rather than cast. A schema is what the model is *asked* for, and an
 * effects dimension that arrives as something else would otherwise reach the
 * generated project as a declaration nothing can enforce.
 */
function oneOf<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const stated = stringField(source, key);
  if (stated === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(stated)) {
    throw new ToolArgumentError(`${key} must be one of ${allowed.join(', ')}`);
  }
  return stated as T;
}

function matching(
  source: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  shape: string,
): string | undefined {
  const stated = stringField(source, key);
  if (stated === undefined) {
    return undefined;
  }
  if (!pattern.test(stated)) {
    throw new ToolArgumentError(`${key} must be ${shape}`);
  }
  return stated;
}

function inputsOf(value: unknown): readonly InputAnswer[] {
  return entries(value, 'inputs').map((one) => {
    const name = stringField(one, 'name');
    const kind = oneOf(one, 'kind', KINDS);
    if (name === undefined || kind === undefined) {
      throw new ToolArgumentError('an input needs a name and a kind');
    }
    const description = stringField(one, 'description');
    return { name, kind, ...(description === undefined ? {} : { description }) };
  });
}

function outcomesOf(value: unknown): readonly OutcomeAnswer[] {
  return entries(value, 'outcomes').map((one) => {
    const id = stringField(one, 'id');
    if (id === undefined) {
      throw new ToolArgumentError('an outcome needs an id');
    }
    const description = stringField(one, 'description');
    return { id, ...(description === undefined ? {} : { description }) };
  });
}

function interactionsOf(value: unknown): readonly InteractionAnswer[] {
  return entries(value, 'interactions').map((one) => {
    const kind = oneOf(one, 'kind', PAUSES);
    const name = stringField(one, 'name');
    const prompt = stringField(one, 'prompt');
    if (kind === undefined) {
      throw new ToolArgumentError('an interaction is input, approval or operator');
    }
    if (name === undefined || prompt === undefined) {
      throw new ToolArgumentError('an interaction needs a name and a prompt');
    }
    // Every `input` pause is a credential as far as the record is concerned: a
    // value obtained mid-run has never been through the field declarations, so
    // nothing else would redact it.
    return { kind, name, prompt, secret: one.secret === true || kind === 'input' };
  });
}

function effectsOf(value: unknown): EffectsDraft {
  if (!isRecord(value)) {
    throw new ToolArgumentError('effects must be an object');
  }

  const mutates = oneOf(value, 'mutates', MUTATES);
  const reversible = oneOf(value, 'reversible', REVERSIBLE);
  const securityEffect = oneOf(value, 'securityEffect', SECURITY);
  const external = oneOf(value, 'external', EXTERNAL);
  // The two dimensions whose values are shapes rather than a fixed list, so
  // what makes the cast honest is the pattern immediately above it.
  const scope = matching(
    value,
    'scope',
    /^(single|unbounded|bounded\(\d+\))$/,
    'single, unbounded, or bounded(n)',
  ) as Scope | undefined;
  const financial = matching(
    value,
    'financial',
    /^(none|moves-funds\(.+\))$/,
    'none, or moves-funds(limit)',
  ) as Financial | undefined;

  let idempotent: boolean | undefined;
  if (value.idempotent !== undefined) {
    if (typeof value.idempotent !== 'boolean') {
      throw new ToolArgumentError('idempotent is true or false');
    }
    idempotent = value.idempotent;
  }

  let dataClasses: readonly DataClass[] | undefined;
  if (value.dataClasses !== undefined) {
    dataClasses = stringList(value.dataClasses, 'dataClasses').map((one) => {
      if (!(DATA_CLASSES as readonly string[]).includes(one)) {
        throw new ToolArgumentError(`dataClasses must be one of ${DATA_CLASSES.join(', ')}`);
      }
      return one as DataClass;
    });
  }

  return {
    ...(mutates === undefined ? {} : { mutates }),
    ...(reversible === undefined ? {} : { reversible }),
    ...(securityEffect === undefined ? {} : { securityEffect }),
    ...(scope === undefined ? {} : { scope }),
    ...(external === undefined ? {} : { external }),
    ...(financial === undefined ? {} : { financial }),
    ...(idempotent === undefined ? {} : { idempotent }),
    ...(dataClasses === undefined ? {} : { dataClasses }),
  };
}

/** What the model wrote down, in the shape the draft takes. */
export function patchOf(call: ToolCall): AnswerPatch {
  const input = call.input;
  const patch: Record<string, unknown> = {};

  for (const key of ['capability', 'task', 'entryPoint', 'output', 'citation']) {
    const stated = stringField(input, key);
    if (stated !== undefined) {
      patch[key] = stated;
    }
  }
  if (input.inputs !== undefined) {
    patch.inputs = inputsOf(input.inputs);
  }
  if (input.outcomes !== undefined) {
    patch.outcomes = outcomesOf(input.outcomes);
  }
  if (input.interactions !== undefined) {
    patch.interactions = interactionsOf(input.interactions);
  }
  if (input.effects !== undefined) {
    patch.effects = effectsOf(input.effects);
  }
  if (input.allowlist !== undefined) {
    // Refused where it is authored rather than at the first navigation it fails
    // to admit: a pattern carrying a port, a scheme or a path matches nothing,
    // and a contract naming a host it cannot actually reach is worse than one
    // that names none.
    patch.allowlist = usableHosts(stringList(input.allowlist, 'allowlist'));
  }
  if (input.budgetUsd !== undefined) {
    if (typeof input.budgetUsd !== 'number' || !Number.isFinite(input.budgetUsd)) {
      throw new ToolArgumentError('budgetUsd must be a number of dollars');
    }
    patch.budgetUsd = input.budgetUsd;
  }

  return patch;
}

/** A `propose` call, as a proposal to put to a person. */
/**
 * Host patterns, refused where they could never admit anything.
 *
 * Called from both authoring routes rather than from one shared place further
 * down, because the *ask* sits between them and `applyAnswers`: validating
 * after the question is put would still have a person confirming a pattern that
 * admits nothing, and a guardrail waved through is exactly what a confirmation
 * exists to prevent. The allowlist is `GUARDED`, so `propose` is the route it
 * actually takes — a guard on `record` alone protects the unused door.
 */
function usableHosts(hosts: readonly string[]): readonly string[] {
  for (const host of hosts) {
    try {
      assertUsablePattern(host);
    } catch (error) {
      throw new ToolArgumentError(error instanceof Error ? error.message : String(error));
    }
  }
  return hosts;
}

export function proposalOf(call: ToolCall): Proposal {
  const field = call.input.field;
  if (field !== 'allowlist' && field !== 'securityEffect') {
    throw new ToolArgumentError('only the allowlist and securityEffect are proposed');
  }

  const value = call.input.value;
  const stated =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? stringList(value, 'value')
        : undefined;
  if (stated === undefined || stated.length === 0) {
    throw new ToolArgumentError('a proposal needs a value');
  }

  if (field === 'allowlist') {
    usableHosts(Array.isArray(stated) ? stated : [stated]);
  }

  const why = call.input.why;
  return { field, value: stated, ...(typeof why === 'string' ? { why } : {}) };
}
