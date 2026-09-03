#!/usr/bin/env node
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
import { balanceLookup } from './index.js';

const PROTOCOL_VERSION = '2025-06-18';
const TOOL = 'balanceLookup';

interface Request {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
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
    "Signs in to the Meridian Bank back-office app and looks up a customer account by its account number, returning that account's current balance.",
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
        secrets
          .map((name) => name.replace(/[A-Z]/g, (l) => '_' + l).toUpperCase())
          .join(', ') +
        ' from its own environment.',
    );
  }

  if (Object.keys(interactions).length > 0) {
    lines.push(
      '',
      'This capability stops to ask a human. A call may return a suspended result; answer it with the resume tool.',
    );
  }

  return lines.join('\n');
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
          sessionId: {
            type: 'string',
            description: 'from the suspended result',
          },
          response: {
            description:
              'a string for an input, true or false for an approval, "done" for an operator hand-back',
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
    const fromEnv =
      process.env[name.replace(/[A-Z]/g, (l) => '_' + l).toUpperCase()];
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

async function call(
  name: string,
  argument: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
    return {
      content: [{ type: 'text', text: 'no such tool: ' + name }],
      isError: true,
    };
  }

  // No resolver: there is nowhere to ask, so the run parks and the suspension
  // comes back as an ordinary result rather than as a failure.
  const result = await balanceLookup(withSecrets(argument), {
    destination: 'stderr',
  });
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
        await call(
          String(params['name']),
          (params['arguments'] ?? {}) as Record<string, unknown>,
        ),
      );
    } catch (error) {
      // Only a hard failure is an error here. A business outcome is an answer,
      // and an exception crossing this boundary would leave the calling agent
      // unable to tell "this account does not exist" from "the application is
      // broken".
      const detail = isReplayError(error)
        ? error.name +
          ': ' +
          error.message +
          ' (run ' +
          error.runId +
          ', step ' +
          error.step +
          ')'
        : error instanceof Error
          ? error.message
          : String(error);
      reply(id, { content: [{ type: 'text', text: detail }], isError: true });
    }
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'no such method' },
    });
  }
}

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
  if (line.trim() === '') {
    continue;
  }
  await handle(JSON.parse(line) as Request);
}
