#!/usr/bin/env node
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
 * must not write it there. `--record` overrides.
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

import {
  balanceLookup,
  effects,
  inputFields,
  interactions,
  type Input,
} from './index.js';

/** The declaration, indexed by name: the literal type has no index signature. */
const declared: FieldSet = inputFields;

/** `accountRef` is asked for as `--account-ref`, and read as `ACCOUNT_REF`. */
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
    const described =
      field.description === undefined ? '' : '  # ' + field.description;
    return '  ' + how + described;
  });

  return ['usage: balance-lookup [options]', '', ...lines, ''].join('\n');
}

function ask(prompt: string, hidden: boolean): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
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
async function keyboard(
  request: InteractionRequest,
): Promise<InteractionResponse> {
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
  process.stderr.write(message + '\n');
  process.exit(2);
}

async function parse(argv: readonly string[]): Promise<Parsed> {
  const values: Record<string, unknown> = {};
  const secrets = new Set(secretFieldNames(inputFields));
  const byFlag = new Map(
    fieldNames(inputFields).map((name) => [flagOf(name), name]),
  );

  let record: RecordDestination = 'stderr';
  let attachmentDir: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    const [flag, inline] = argument.includes('=')
      ? [
          argument.slice(0, argument.indexOf('=')),
          argument.slice(argument.indexOf('=') + 1),
        ]
      : [argument, undefined];

    if (flag === '--help' || flag === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }

    const take = (): string =>
      inline ?? argv[++index] ?? fail('missing value for ' + flag);

    if (flag === '--record') {
      const where = take();
      record =
        where === 'stdout' || where === 'stderr' ? where : { file: where };
      continue;
    }

    if (flag === '--attachments') {
      attachmentDir = take();
      continue;
    }

    const name = byFlag.get(flag);
    if (name === undefined) {
      fail('unknown option ' + flag + '\n\n' + usage());
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
      fail('missing ' + flagOf(name) + '\n\n' + usage());
    }
    const fromEnv = process.env[envOf(name)];
    values[name] = makeSecret(
      fromEnv ??
        (await ask(name + ' (' + envOf(name) + ' is not set): ', true)),
    );
  }

  return attachmentDir === undefined
    ? { values, record }
    : { values, record, attachmentDir };
}

async function main(): Promise<void> {
  const parsed = await parse(process.argv.slice(2));

  // Headed where a human has to see the session: an operator pause uses the
  // window that is already open, and a capability that changes who can access an
  // account is refused a headless run outright.
  const headless =
    effects.securityEffect === 'none' &&
    !Object.values(interactions).some(
      (declared) => declared.kind === 'operator',
    );

  try {
    const result = await balanceLookup(parsed.values as Input, {
      resolver: keyboard,
      destination: parsed.record,
      headless,
      ...(parsed.attachmentDir === undefined
        ? {}
        : { attachmentDir: parsed.attachmentDir }),
    });

    // No suspended arm to handle: a resolver is supplied, so the engine asks and
    // loops internally and the type says the run cannot park.
    process.stdout.write(JSON.stringify(result, undefined, 2) + '\n');
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
        ].join('\n') + '\n',
      );
      process.exit(1);
    }
    throw error;
  }
}

await main();
