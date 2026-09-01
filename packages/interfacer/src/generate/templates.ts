/**
 * The two entry points every capability gets, verbatim.
 *
 * They are the same source in every project because they contain no
 * capability-specific knowledge: both read `inputFields`, `effects` and the
 * flow's declared answers at run time rather than having a schema or a flag list
 * baked into them. Only the master function's name and the package's own name
 * are substituted, which is what the two placeholders are for.
 *
 * They are emitted into the project rather than imported from a library because
 * the project is the artifact: a reviewer reads its entry points, and an owner
 * is free to edit them.
 */

/** The exported master function, named for the capability id. */
export const CAPABILITY = '__CAPABILITY__';
/** The npm package name, and what `npx` runs. */
export const PACKAGE = '__PACKAGE__';
/** The one-line description, already quoted as a TypeScript string literal. */
export const DESCRIPTION = '__DESCRIPTION__';

export const CLI_TEMPLATE = `#!/usr/bin/env node
/**
 * The command line: one of three equal surfaces over the master function.
 *
 * Success and every declared business outcome print the result as JSON and exit
 * 0, because both are answers. A hard failure prints the error and the run id to
 * stderr and exits nonzero. Nothing suspends: a resolver reads the answer from
 * the keyboard in place, so the command stays a single blocking invocation.
 *
 * The run record goes to stderr here rather than to the engine's default of
 * stdout, because stdout carries the answer — the same reason the MCP server
 * must not write it there. \`--record\` overrides.
 */
import { createInterface } from 'node:readline';

import {
  fieldNames,
  isReplayError,
  makeSecret,
  secretFieldNames,
  type FieldSet,
  type InteractionRequest,
  type InteractionResponse,
  type RecordDestination,
} from '@interfacer/dsl';

import { __CAPABILITY__, effects, inputFields, interactions, type Input } from './index.js';

/** The declaration, indexed by name: the literal type has no index signature. */
const declared: FieldSet = inputFields;

/** \`accountRef\` is asked for as \`--account-ref\`, and read as \`ACCOUNT_REF\`. */
function flagOf(name: string): string {
  return '--' + name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
}

function envOf(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => '_' + letter).toUpperCase();
}

function usage(): string {
  const lines = fieldNames(inputFields).map((name) => {
    const field = declared[name];
    const how =
      field.kind === 'secret'
        ? 'from ' + envOf(name) + ' or the keyboard — never on the command line'
        : flagOf(name) + ' <' + field.kind + '>';
    const described = field.description === undefined ? '' : '  # ' + field.description;
    return '  ' + how + described;
  });

  return ['usage: __PACKAGE__ [options]', '', ...lines, ''].join('\\n');
}

function ask(prompt: string, hidden: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (line) => {
      rl.close();
      resolve(hidden ? line : line);
    });
  });
}

/**
 * The built-in resolver: one function for every kind of pause, which is what
 * keeps a caller's policy in one place rather than three.
 */
async function keyboard(request: InteractionRequest): Promise<InteractionResponse> {
  if (request.kind === 'approval') {
    const answer = await ask(request.prompt + ' [y/N] ', false);
    return /^y/i.test(answer.trim());
  }

  if (request.kind === 'operator') {
    // The browser is already headed for this case: the flow stops driving it,
    // the human uses that same window, and Enter signals resume.
    await ask(request.prompt + ' — press Enter when done ', false);
    return 'done';
  }

  const value = await ask(request.prompt + ' ', true);
  return makeSecret(value.trim());
}

interface Parsed {
  readonly values: Record<string, unknown>;
  readonly record: RecordDestination;
  readonly attachmentDir?: string;
}

function fail(message: string): never {
  process.stderr.write(message + '\\n');
  process.exit(2);
}

async function parse(argv: readonly string[]): Promise<Parsed> {
  const values: Record<string, unknown> = {};
  const secrets = new Set(secretFieldNames(inputFields));
  const byFlag = new Map(fieldNames(inputFields).map((name) => [flagOf(name), name]));

  let record: RecordDestination = 'stderr';
  let attachmentDir: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    const [flag, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined];

    if (flag === '--help' || flag === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }

    const take = (): string => inline ?? argv[++index] ?? fail('missing value for ' + flag);

    if (flag === '--record') {
      const where = take();
      record = where === 'stdout' || where === 'stderr' ? where : { file: where };
      continue;
    }

    if (flag === '--attachments') {
      attachmentDir = take();
      continue;
    }

    const name = byFlag.get(flag);
    if (name === undefined) {
      fail('unknown option ' + flag + '\\n\\n' + usage());
    }

    if (secrets.has(name)) {
      // Never on argv: it would land in shell history and in process listings.
      fail(
        flag +
          ' is a secret and is not accepted on the command line — set ' +
          envOf(name) +
          ' instead, or leave it out and answer the prompt',
      );
    }

    const field = declared[name];
    values[name] =
      field.kind === 'boolean'
        ? inline === undefined
          ? true
          : inline === 'true'
        : field.kind === 'number'
          ? Number(take())
          : take();
  }

  for (const name of fieldNames(inputFields)) {
    if (name in values) {
      continue;
    }
    if (!secrets.has(name)) {
      fail('missing ' + flagOf(name) + '\\n\\n' + usage());
    }
    const fromEnv = process.env[envOf(name)];
    values[name] = makeSecret(
      fromEnv ?? (await ask(name + ' (' + envOf(name) + ' is not set): ', true)),
    );
  }

  return attachmentDir === undefined ? { values, record } : { values, record, attachmentDir };
}

async function main(): Promise<void> {
  const parsed = await parse(process.argv.slice(2));

  // Headed where a human has to see the session: an operator pause uses the
  // window that is already open, and a capability that changes who can access an
  // account is refused a headless run outright.
  const headless =
    effects.securityEffect === 'none' &&
    !Object.values(interactions).some((declared) => declared.kind === 'operator');

  try {
    const result = await __CAPABILITY__(parsed.values as Input, {
      resolver: keyboard,
      destination: parsed.record,
      headless,
      ...(parsed.attachmentDir === undefined ? {} : { attachmentDir: parsed.attachmentDir }),
    });

    // No suspended arm to handle: a resolver is supplied, so the engine asks and
    // loops internally and the type says the run cannot park.
    process.stdout.write(JSON.stringify(result, undefined, 2) + '\\n');
    process.exit(0);
  } catch (error) {
    if (isReplayError(error)) {
      process.stderr.write(
        [
          error.name + ': ' + error.message,
          '  run:      ' + error.runId,
          '  step:     ' + error.step,
          '  expected: ' + error.expected,
          '  observed: ' + error.observed,
          ...(parsed.attachmentDir === undefined
            ? []
            : ['  evidence: ' + parsed.attachmentDir]),
        ].join('\\n') + '\\n',
      );
      process.exit(1);
    }
    throw error;
  }
}

await main();
`;

export const MCP_TEMPLATE = `#!/usr/bin/env node
/**
 * The MCP server: one of three equal surfaces over the master function.
 *
 * One project is one capability, so the server exposes exactly one tool, named
 * for the capability id. Its input schema is read from the field declarations
 * and its output schema from the flow's declared answers, so a calling agent
 * sees every business outcome as a possible answer rather than meeting one as an
 * error. Only a hard failure sets isError.
 *
 * It speaks newline-delimited JSON-RPC over stdio, which is what local means
 * here: the client launches this as a child process, and there is no listener,
 * no port and no network surface. The framing is written out rather than taken
 * from a library, so a capability in production depends on the DSL and nothing
 * else.
 *
 * The run record goes to stderr. stdout is the protocol transport, and entries
 * written onto it corrupt it.
 */
import { createInterface } from 'node:readline';

import {
  answerSchema,
  fieldNames,
  inputSchema,
  isReplayError,
  makeSecret,
  secretFieldNames,
  type InteractionResponse,
} from '@interfacer/dsl';

import {
  effects,
  flow,
  interactions,
  inputFields,
  resume,
  version,
  type Input,
} from './index.js';
import { __CAPABILITY__ } from './index.js';

const PROTOCOL_VERSION = '2025-06-18';
const TOOL = '__CAPABILITY__';

interface Request {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function reply(id: string | number, result: Record<string, unknown>): void {
  send({ jsonrpc: '2.0', id, result });
}

/**
 * The effects, in the description, so an agent can see that a capability writes,
 * moves funds or changes authority before deciding to call it.
 */
function describe(): string {
  const lines = [
    __DESCRIPTION__,
    '',
    'Effects: mutates ' +
      effects.mutates +
      ', reversible ' +
      effects.reversible +
      ', securityEffect ' +
      effects.securityEffect +
      ', scope ' +
      effects.scope +
      ', external ' +
      effects.external +
      ', financial ' +
      effects.financial +
      ', idempotent ' +
      String(effects.idempotent) +
      ', dataClasses ' +
      effects.dataClasses.join('/'),
  ];

  const secrets = secretFieldNames(inputFields);
  if (secrets.length > 0) {
    lines.push(
      '',
      'Credentials are not tool arguments: this server reads ' +
        secrets.map((name) => name.replace(/[A-Z]/g, (l) => '_' + l).toUpperCase()).join(', ') +
        ' from its own environment.',
    );
  }

  if (Object.keys(interactions).length > 0) {
    lines.push(
      '',
      'This capability stops to ask a human. A call may return a suspended result; answer it with the resume tool.',
    );
  }

  return lines.join('\\n');
}

function tools(): readonly Record<string, unknown>[] {
  const listed: Record<string, unknown>[] = [
    {
      name: TOOL,
      description: describe(),
      inputSchema: inputSchema(inputFields),
      outputSchema: answerSchema(flow),
    },
  ];

  if (Object.keys(interactions).length > 0) {
    // A tool cannot call back into its caller mid-execution, so parking is
    // forced rather than chosen, and this is how an answer gets back in.
    listed.push({
      name: 'resume',
      description: 'Answer a suspended run of ' + TOOL + '.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'from the suspended result' },
          response: {
            description: 'a string for an input, true or false for an approval, "done" for an operator hand-back',
          },
        },
        required: ['sessionId', 'response'],
        additionalProperties: false,
      },
    });
  }

  return listed;
}

/** Secrets reach the server as environment, set once where the client registers it. */
function withSecrets(argument: Record<string, unknown>): Input {
  const values: Record<string, unknown> = { ...argument };

  for (const name of secretFieldNames(inputFields)) {
    const fromEnv = process.env[name.replace(/[A-Z]/g, (l) => '_' + l).toUpperCase()];
    if (fromEnv === undefined) {
      throw new Error(
        'the server is missing ' +
          name.replace(/[A-Z]/g, (l) => '_' + l).toUpperCase() +
          ' in its environment',
      );
    }
    values[name] = makeSecret(fromEnv);
  }

  for (const name of fieldNames(inputFields)) {
    if (!(name in values)) {
      throw new Error('missing argument ' + name);
    }
  }

  return values as Input;
}

function answered(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, undefined, 2) }],
    structuredContent: result,
  };
}

async function call(name: string, argument: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === 'resume') {
    const response = argument['response'];
    const answer: InteractionResponse =
      typeof response === 'boolean'
        ? response
        : response === 'done'
          ? 'done'
          : makeSecret(String(response));
    return answered(await resume(String(argument['sessionId']), answer));
  }

  if (name !== TOOL) {
    return { content: [{ type: 'text', text: 'no such tool: ' + name }], isError: true };
  }

  // No resolver: there is nowhere to ask, so the run parks and the suspension
  // comes back as an ordinary result rather than as a failure.
  const result = await __CAPABILITY__(withSecrets(argument), { destination: 'stderr' });
  return answered(result);
}

async function handle(request: Request): Promise<void> {
  const { id } = request;

  if (request.method === 'initialize') {
    if (id !== undefined) {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: TOOL, version },
      });
    }
    return;
  }

  if (request.method === 'tools/list') {
    if (id !== undefined) {
      reply(id, { tools: tools() });
    }
    return;
  }

  if (request.method === 'tools/call') {
    if (id === undefined) {
      return;
    }
    const params = request.params ?? {};
    try {
      reply(
        id,
        await call(String(params['name']), (params['arguments'] ?? {}) as Record<string, unknown>),
      );
    } catch (error) {
      // Only a hard failure is an error here. A business outcome is an answer,
      // and an exception crossing this boundary would leave the calling agent
      // unable to tell "this account does not exist" from "the application is
      // broken".
      const detail = isReplayError(error)
        ? error.name + ': ' + error.message + ' (run ' + error.runId + ', step ' + error.step + ')'
        : error instanceof Error
          ? error.message
          : String(error);
      reply(id, { content: [{ type: 'text', text: detail }], isError: true });
    }
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no such method' } });
  }
}

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
  if (line.trim() === '') {
    continue;
  }
  await handle(JSON.parse(line) as Request);
}
`;
