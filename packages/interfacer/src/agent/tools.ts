/**
 * The model's tools: the DSL vocabulary, one tool per verb.
 *
 * Calling a tool executes it against the live session and, if it succeeds,
 * appends that step to the flow. **Acting and recording are one operation**, so
 * the flow cannot drift from what actually happened: there is no separate "write
 * down what you did" step to get wrong, and no transcript to reconstruct the
 * artifact from afterwards.
 *
 * The model never writes TypeScript. It fills in these schemas, Interfacer
 * appends the step, and the source is emitted from the accumulated flow — which
 * is what makes the artifact structurally unable to contain anything the
 * vocabulary does not permit.
 *
 * `snapshot` and `screenshot` observe and record nothing; `ask` puts a question
 * to the human without becoming a step. Everything else is a verb whose success
 * is an append.
 */
import {
  answer,
  asMoney,
  asNumber,
  asText,
  extracted,
  field,
  join,
  literal,
  obtained,
  type Described,
  type Flow,
  type FieldSet,
  type Step,
  type TargetChain,
} from '@interfacer/dsl';

import type { ToolDefinition } from './decide.js';

/** A target chain, best-first, in the shape `Target` already has. */
const TARGET_CHAIN = {
  type: 'array',
  minItems: 1,
  description:
    'How the control is identified, best-first: the semantic strategy that should survive a release, backed by the selector observed to work.',
  items: {
    type: 'object',
    oneOf: [
      {
        properties: {
          by: { const: 'role' },
          role: { type: 'string' },
          name: {
            description: 'The accessible name, or several where wording varies by tenant.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        },
        required: ['by', 'role'],
      },
      {
        properties: {
          by: { const: 'label' },
          text: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        },
        required: ['by', 'text'],
      },
      { properties: { by: { const: 'text' }, text: { type: 'string' } }, required: ['by', 'text'] },
      {
        properties: { by: { const: 'css' }, selector: { type: 'string' } },
        required: ['by', 'selector'],
      },
    ],
  },
} as const;

/** Where a value comes from. Never a literal for something a caller supplies. */
const VALUE = {
  type: 'object',
  description:
    'Which declared input this reads. A flow is parameterized by construction: it holds no live values.',
  oneOf: [
    {
      properties: { from: { const: 'input' }, name: { type: 'string' } },
      required: ['from', 'name'],
    },
    {
      properties: { from: { const: 'obtained' }, name: { type: 'string' } },
      required: ['from', 'name'],
    },
    {
      properties: { from: { const: 'literal' }, value: { type: 'string' } },
      required: ['from', 'value'],
    },
    {
      properties: {
        from: { const: 'join' },
        parts: { type: 'array', items: { type: 'object' } },
      },
      required: ['from', 'parts'],
    },
  ],
} as const;

function schema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'open',
    description: 'Navigate to an entry point. Checked against the allowlist on the resolved URL.',
    inputSchema: schema({ url: VALUE }, ['url']),
  },
  {
    name: 'fillForm',
    description: 'Type a declared input into a field.',
    inputSchema: schema({ target: TARGET_CHAIN, value: VALUE }, ['target', 'value']),
  },
  {
    name: 'pressButton',
    description: 'Activate a control that changes nothing irreversibly.',
    inputSchema: schema({ target: TARGET_CHAIN }, ['target']),
  },
  {
    name: 'commit',
    description:
      'Activate the control that is the point of no return. Never retried, and an approval must precede it where the declared effects require one.',
    inputSchema: schema({ target: TARGET_CHAIN }, ['target']),
  },
  {
    name: 'choose',
    description: 'Set a select or a radio group.',
    inputSchema: schema({ target: TARGET_CHAIN, value: VALUE }, ['target', 'value']),
  },
  {
    name: 'checkpoint',
    description:
      'Assert that the expected state was reached. Fails the run at replay if it is not.',
    inputSchema: schema({ target: TARGET_CHAIN }, ['target']),
  },
  {
    name: 'extract',
    description: 'Read a value out of the page and give it a name.',
    inputSchema: schema(
      {
        name: { type: 'string' },
        target: TARGET_CHAIN,
        parse: { enum: ['text', 'number', 'money'] },
      },
      ['name', 'target', 'parse'],
    ),
  },
  {
    name: 'pauseUntil',
    description: 'Wait for a surface to arrive, with a bound. Never a sleep.',
    inputSchema: schema({ target: TARGET_CHAIN, within: { type: 'string' } }, ['target']),
  },
  {
    name: 'pauseForInput',
    description: 'Ask a human for a value that cannot be known in advance, and record the pause.',
    inputSchema: schema({ name: { type: 'string' }, prompt: { type: 'string' } }, [
      'name',
      'prompt',
    ]),
  },
  {
    name: 'pauseForApproval',
    description: 'Ask a human to authorize the step that follows, and record the pause.',
    inputSchema: schema({ prompt: { type: 'string' } }, ['prompt']),
  },
  {
    name: 'pauseForOperator',
    description: 'Hand the live window to a human, and record the pause.',
    inputSchema: schema({ reason: { type: 'string' } }, ['reason']),
  },
  {
    name: 'outcome',
    description:
      'Declare a business outcome and the page condition that detects it. A legitimate answer, not a failure.',
    inputSchema: schema(
      {
        status: { type: 'string' },
        detector: TARGET_CHAIN,
        values: {
          type: 'object',
          description: 'Fields to report with it, read from the input or stated outright.',
          additionalProperties: VALUE,
        },
      },
      ['status', 'detector'],
    ),
  },
  {
    name: 'returns',
    description: 'Declare the success result, built from what extract read. This ends discovery.',
    inputSchema: schema(
      {
        status: { type: 'string' },
        values: {
          type: 'object',
          description: 'Extracted names to report, keyed by the name the caller sees.',
          additionalProperties: { type: 'string' },
        },
      },
      ['status'],
    ),
  },
  {
    name: 'snapshot',
    description: 'Look at the page again. Records nothing.',
    inputSchema: schema({}, []),
  },
  {
    name: 'screenshot',
    description:
      'Look at a picture of the page, for when the tree is ambiguous. It informs a decision and can never be a target.',
    inputSchema: schema({}, []),
  },
  {
    name: 'ask',
    description: 'Put a question to the human — a live value, or help when stuck. Records nothing.',
    inputSchema: schema({ question: { type: 'string' } }, ['question']),
  },
]);

export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((tool) => tool.name));

/** A value source as the model states it, turned into a described accessor. */
interface ValueSpec {
  readonly from: string;
  readonly name?: string;
  readonly value?: string;
  readonly parts?: readonly ValueSpec[];
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * An accessor with its input type erased.
 *
 * The agent's flow comes from an interview, so its input type is not known in
 * this file — but a function taking `never` is assignable wherever an accessor
 * is expected, which confines the erasure to this one alias instead of putting a
 * cast at every call site.
 */
type AnyAccessor = ((...args: readonly unknown[]) => never) & Described;

function accessorFor(spec: unknown): AnyAccessor {
  const value = spec as ValueSpec;
  switch (value.from) {
    case 'input':
      return field<Record<string, unknown>, string>(requireName(value)) as unknown as AnyAccessor;
    case 'obtained':
      return obtained<Record<string, unknown>, string>(
        requireName(value),
      ) as unknown as AnyAccessor;
    case 'extracted':
      return extracted<Record<string, unknown>, string>(
        requireName(value),
      ) as unknown as AnyAccessor;
    case 'literal':
      if (typeof value.value !== 'string') {
        throw new ToolArgumentError('a literal needs a string value');
      }
      return literal(value.value) as unknown as AnyAccessor;
    case 'join':
      if (value.parts === undefined || value.parts.length === 0) {
        throw new ToolArgumentError('a join needs parts');
      }
      return join(
        ...value.parts.map((part) => accessorFor(part) as never),
      ) as unknown as AnyAccessor;
    default:
      throw new ToolArgumentError(`unknown value source ${JSON.stringify(value.from)}`);
  }
}

function requireName(value: ValueSpec): string {
  if (typeof value.name !== 'string' || value.name === '') {
    throw new ToolArgumentError(`a ${value.from} value needs a name`);
  }
  return value.name;
}

const PARSES = { text: asText, number: asNumber, money: asMoney } as const;

function chain(raw: unknown): TargetChain {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolArgumentError('a target must be a non-empty chain');
  }
  return raw as unknown as TargetChain;
}

function text(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value === '') {
    throw new ToolArgumentError(`${key} is required`);
  }
  return value;
}

/**
 * Append the step a tool call describes, and hand it back to be performed.
 *
 * The step is appended first because the builder is the only thing that derives
 * an id, and the id has to exist before the step runs so the record refers to
 * it. A step that then fails is taken back — see `Flow#retract`.
 */
export function appendStep(
  flow: Flow<FieldSet, unknown>,
  call: { readonly name: string; readonly input: Readonly<Record<string, unknown>> },
): Step {
  const { input } = call;
  const before = flow.steps.length;

  switch (call.name) {
    case 'open':
      flow.open(accessorFor(input.url));
      break;
    case 'fillForm':
      flow.fillForm(chain(input.target), accessorFor(input.value));
      break;
    case 'pressButton':
      flow.pressButton(chain(input.target));
      break;
    case 'commit':
      flow.commit(chain(input.target));
      break;
    case 'choose':
      flow.choose(chain(input.target), accessorFor(input.value));
      break;
    case 'checkpoint':
      flow.checkpoint(chain(input.target));
      break;
    case 'extract': {
      const parse = input.parse;
      if (parse !== 'text' && parse !== 'number' && parse !== 'money') {
        throw new ToolArgumentError('parse must be text, number or money');
      }
      // Annotated rather than cast: the three parses return different types, and
      // the flow's own type is not known here.
      const read: (of: string) => unknown = PARSES[parse];
      flow.extract(text(input, 'name'), chain(input.target), read);
      break;
    }
    case 'pauseUntil':
      flow.pauseUntil(
        chain(input.target),
        typeof input.within === 'string' ? { within: input.within } : {},
      );
      break;
    case 'pauseForInput':
      flow.pauseForInput(text(input, 'name'), { prompt: text(input, 'prompt') });
      break;
    case 'pauseForApproval':
      flow.pauseForApproval(text(input, 'prompt'));
      break;
    case 'pauseForOperator':
      flow.pauseForOperator(text(input, 'reason'));
      break;
    default:
      throw new ToolArgumentError(`${call.name} does not append a step`);
  }

  const step = flow.steps.at(-1);
  if (step === undefined || flow.steps.length !== before + 1) {
    throw new ToolArgumentError(`${call.name} appended nothing`);
  }
  return step;
}

/** The `answer()` map an `outcome` or `returns` call describes. */
export function answerFor(call: {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}): AnyAccessor {
  const status = text(call.input, 'status');
  const values = (call.input.values ?? {}) as Record<string, unknown>;

  const built: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(values)) {
    built[key] =
      call.name === 'returns'
        ? extracted<Record<string, unknown>, string>(
            typeof spec === 'string' ? spec : requireName(spec as ValueSpec),
          )
        : accessorFor(spec);
  }

  return answer<string, unknown, unknown, Record<string, AnyAccessor>>(
    status,
    built as Record<string, AnyAccessor>,
  ) as unknown as AnyAccessor;
}
