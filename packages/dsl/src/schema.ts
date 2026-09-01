/**
 * The contract, projected as JSON Schema.
 *
 * An MCP tool publishes an input schema and an output schema, and both are read
 * from the declarations rather than written beside them — the same rule that
 * makes `fields()` a value in the first place. A schema frozen into a generated
 * file at generation time would be exactly the second representation the
 * artifact-as-program design exists to avoid: edit a field, and the served
 * schema would go on describing the old one.
 *
 * It lives here rather than in the generator because every generated project
 * needs the identical projection, and a copy per project is the same duplication
 * wearing a different hat. Nothing about it is MCP-specific: it describes the
 * capability's inputs and answers, and MCP is one reader.
 */
import type { Described } from './accessors.js';
import type { Field, FieldSet } from './fields.js';
import type { Flow } from './flow.js';

export interface JsonSchema {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly const?: string | number | boolean;
  readonly enum?: readonly string[];
  readonly oneOf?: readonly JsonSchema[];
}

const JSON_TYPE: Readonly<Record<Field['kind'], string>> = {
  text: 'string',
  number: 'number',
  boolean: 'boolean',
  // A secret never reaches this schema, but the mapping is total rather than
  // partial so that adding a field kind cannot silently produce a typeless
  // property.
  secret: 'string',
};

/**
 * The input schema a caller sees — every declared field except the secrets.
 *
 * Secrets are omitted rather than marked, because a schema that asks for a
 * password invites an agent to hold one. They reach a server as environment
 * instead, which is the same rule as the CLI's refusal on argv applied to a
 * different kind of caller.
 */
export function inputSchema(declaration: FieldSet): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [name, field] of Object.entries(declaration)) {
    if (field.kind === 'secret') {
      continue;
    }
    properties[name] = {
      type: JSON_TYPE[field.kind],
      ...(field.description === undefined ? {} : { description: field.description }),
    };
    required.push(name);
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

/** One arm of the answer union, as the flow declared it. */
export interface AnswerShape {
  readonly status: string;
  readonly values: Readonly<Record<string, JsonSchema>>;
}

function described(map: unknown): (Described & { source: { from: 'answer' } }) | undefined {
  if (typeof map !== 'function' || !('source' in map)) {
    return undefined;
  }
  const { source } = map as Described;
  return source.from === 'answer' ? (map as Described & { source: { from: 'answer' } }) : undefined;
}

/** What each `.extract()` parses to, so an extracted value gets a type. */
function extractedTypes(flow: Flow<FieldSet, unknown>): Readonly<Record<string, string>> {
  const types: Record<string, string> = {};
  for (const step of flow.steps) {
    if (step.kind === 'extract') {
      const parse = step.parse as unknown;
      const source =
        typeof parse === 'function' && 'source' in parse ? (parse as Described).source : undefined;
      types[step.name] = source?.from === 'parse' && source.as !== 'text' ? 'number' : 'string';
    }
  }
  return types;
}

/**
 * The answers a capability can give, each arm with its own fields.
 *
 * Read off the descriptors the flow already carries, which is what `answer()`
 * exists for: a calling agent sees `account_not_found` as a declared possible
 * answer rather than meeting it as an error, and it sees the shape that comes
 * with it.
 */
export function answerShapes(flow: Flow<FieldSet, unknown>): readonly AnswerShape[] {
  const extracted = extractedTypes(flow);
  const shapes: AnswerShape[] = [];

  const arms = [...flow.outcomes.map((outcome) => outcome.map), flow.result];

  for (const map of arms) {
    const answer = described(map);
    if (answer === undefined) {
      // A hand-written mapper describes nothing, and guessing at its shape would
      // publish a schema the capability does not honour.
      continue;
    }

    const values: Record<string, JsonSchema> = {};
    for (const [key, source] of Object.entries(answer.source.values)) {
      switch (source.from) {
        case 'literal':
          values[key] = { type: typeof source.value, const: source.value };
          break;
        case 'input':
          values[key] = { type: JSON_TYPE[flow.input[source.name]?.kind ?? 'text'] };
          break;
        case 'extracted':
          values[key] = { type: extracted[source.name] ?? 'string' };
          break;
        default:
          values[key] = { type: 'string' };
          break;
      }
    }

    shapes.push({ status: answer.source.status, values });
  }

  return shapes;
}

/** The output schema: one arm per declared answer, discriminated by `status`. */
export function answerSchema(flow: Flow<FieldSet, unknown>): JsonSchema {
  const shapes = answerShapes(flow);

  return {
    oneOf: shapes.map((shape) => ({
      type: 'object',
      properties: { status: { type: 'string', const: shape.status }, ...shape.values },
      required: ['status', ...Object.keys(shape.values)],
      additionalProperties: false,
    })),
  };
}
