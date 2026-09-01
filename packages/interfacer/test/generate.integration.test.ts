import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { startAll, type FixtureBundle } from '@interfacer/fixtures';
import { makeSecret } from '@interfacer/dsl';
import { generateProject, writeProject } from 'interfacer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attendedCapability, balanceCapability, variant, type BalanceInput } from './capability.js';

/**
 * A generated project, installed, compiled, and driven against a real fixture.
 *
 * This is the phase's whole claim: that what Interfacer writes is a complete
 * Node project which builds and runs with nothing added. Asserting on the
 * emitted *source* would prove only that the printer prints — the artifact is a
 * program, so the test compiles it and calls it.
 *
 * It generates into a temporary directory outside the source tree, on purpose.
 * A project that only builds where it was made is not portable, and a test that
 * built one inside this repo would be resolving the DSL, Playwright and even
 * TypeScript by walking up into the workspace — proving portability it had
 * quietly arranged. Everything here comes out of the project's own
 * `node_modules`, installed from the project's own `package.json`, including the
 * `tsc` that compiles it.
 */

/**
 * The directory `afterAll` removes.
 *
 * Held rather than derived from a project's path. Deriving it — `dirname(ROOT)`
 * — is one refactor away from being the system temp root itself, and this is a
 * recursive, forced delete.
 */
let scratch: string | undefined;

/** Assigned in `beforeAll`: a fresh directory under {@link scratch}. */
let ROOT: string;
/** The same capability with a declared pause, so the attended surface has a subject. */
let ATTENDED_ROOT: string;
const run = promisify(execFile);

let bundle: FixtureBundle;

/** The compiled master function, imported the way any library caller would. */
interface Generated {
  checkAccountBalance: (
    input: BalanceInput,
    options?: { resolver?: unknown; destination?: unknown; timeoutMs?: number },
  ) => Promise<{ status: string; [key: string]: unknown }>;
  isReplayError: (error: unknown) => error is Error & { runId: string; step: string };
  interactions: Record<string, unknown>;
  version: string;
}

let generated: Generated;

beforeAll(async () => {
  bundle = await startAll();

  scratch = await mkdtemp(join(tmpdir(), 'interfacer-generated-'));
  ROOT = join(scratch, 'mybank-balance');
  ATTENDED_ROOT = join(scratch, 'mybank-attended');

  await build(ROOT, {
    flow: balanceCapability(),
    packageName: 'mybank-balance',
    description: 'Read an account balance from the back office.',
    variant,
  });

  generated = (await import(join(ROOT, 'dist/index.js'))) as Generated;

  await build(ATTENDED_ROOT, {
    flow: attendedCapability(),
    packageName: 'mybank-attended',
    description: 'Read an account balance, stopping for a one-time code.',
    variant,
  });
}, 600_000);

afterAll(async () => {
  await bundle.closeAll();
  // Two projects with their own `node_modules`, Playwright included, so this is
  // worth tens of megabytes a run. Guarded on the setup having got far enough to
  // make one, so a failure before that surfaces as itself.
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
  }
});

/** Emit a project, install it, and build it with the tools it asked for. */
async function build(root: string, request: Parameters<typeof generateProject>[0]): Promise<void> {
  await writeProject(await generateProject(request), root);
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: root });
  await run(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: root });
}

function input(overrides: Partial<BalanceInput> = {}): BalanceInput {
  return {
    url: bundle.fixtures.clean.url,
    username: 'teller1',
    password: makeSecret('s3cret-teller'),
    accountRef: 'ACC-1001',
    ...overrides,
  };
}

const QUIET = { destination: 'stderr' as const, timeoutMs: 3_000 };

// @covers artifact.is-a-buildable-project
describe('what generation produced', () => {
  it('is a project that installs and compiles with nothing added', () => {
    // `npm i && tsc` ran in `beforeAll`; that it got here is the assertion. What
    // is left to check is that the build produced the entry points the package
    // declares, rather than merely type-checking.
    expect(generated.version).toBe('0.1.0');
    expect(typeof generated.checkAccountBalance).toBe('function');
  });
});

// @covers project.three-equal-surfaces
describe('called as a library', () => {
  it('returns the success arm', async () => {
    const answer = await generated.checkAccountBalance(input(), QUIET);

    expect(answer).toEqual({ status: 'ok', balance: 1250.75 });
  });

  it('returns a declared business outcome rather than throwing it', async () => {
    // The run succeeded: it found out something true. A caller that handles
    // every arm of the union has handled every answer the capability can give.
    const answer = await generated.checkAccountBalance(input({ accountRef: 'ACC-9999' }), QUIET);

    expect(answer).toEqual({ status: 'account_not_found', accountRef: 'ACC-9999' });
  });

  it('returns the other one', async () => {
    const answer = await generated.checkAccountBalance(
      input({ username: 'viewer1', password: makeSecret('s3cret-viewer'), accountRef: 'ACC-2002' }),
      QUIET,
    );

    expect(answer).toEqual({ status: 'permission_denied', requiredRole: 'TELLER' });
  });

  it('throws a hard failure, and the guard it exports types the catch', async () => {
    const failure = await generated
      .checkAccountBalance(input({ url: `${bundle.fixtures.clean.url}/?_fx=app-error` }), QUIET)
      .catch((error: unknown) => error);

    expect(generated.isReplayError(failure)).toBe(true);
    expect(generated.isReplayError(failure) && failure.runId).toMatch(/^run_/);
  });
});

// ---------------------------------------------------------------------------

/** Compile one extra file inside the generated project, and say whether it did. */
async function typeChecks(source: string): Promise<string | undefined> {
  const path = join(ROOT, 'src/check.ts');
  await writeFile(path, source, 'utf8');
  try {
    await run(join(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--noEmit'], {
      cwd: ROOT,
    });
    return undefined;
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? error);
  } finally {
    await rm(path, { force: true });
  }
}

// @covers contract.answer-union-inferred
describe('the Answer union the project publishes', () => {
  it('carries every declared outcome, and the compiler knows each arm', async () => {
    // A type-level test because the claim is about types: a run that happens not
    // to return `account_not_found` proves nothing about whether a caller is
    // obliged to handle it.
    const failure = await typeChecks(`
      import type { Answer } from './index.js';

      declare const answer: Answer;

      export function exhaustive(): string | number {
        switch (answer.status) {
          case 'ok':
            return answer.balance;
          case 'account_not_found':
            return answer.accountRef;
          case 'permission_denied':
            return answer.requiredRole;
        }
      }
    `);

    expect(failure).toBeUndefined();
  });

  it('has no arm the flow did not declare', async () => {
    const failure = await typeChecks(`
      import type { Answer } from './index.js';

      declare const answer: Answer;

      export const wrong: string = answer.status === 'invented' ? 'yes' : 'no';
    `);

    expect(failure).toMatch(/invented/);
  });
});

// @covers project.resolver-removes-the-suspended-arm
describe('the master function overloads', () => {
  it('drops the suspended arm when a resolver is supplied', async () => {
    const failure = await typeChecks(`
      import { checkAccountBalance, type Answer, type Resolver } from './index.js';
      import type { Input } from './contract.js';

      declare const input: Input;
      declare const resolver: Resolver;

      export async function attended(): Promise<Answer> {
        // No 'suspended' arm to narrow away: with somewhere to ask, the engine
        // asks and loops internally.
        return await checkAccountBalance(input, { resolver });
      }

      export async function unattended(): Promise<string> {
        const result = await checkAccountBalance(input);
        return result.status;
      }
    `);

    expect(failure).toBeUndefined();
  });

  it('keeps it when no resolver is', async () => {
    const failure = await typeChecks(`
      import { checkAccountBalance, type Answer } from './index.js';
      import type { Input } from './contract.js';

      declare const input: Input;

      export async function wrong(): Promise<Answer> {
        // Without a resolver the run can park, and the caller has to say what it
        // does about that.
        return await checkAccountBalance(input);
      }
    `);

    expect(failure).toMatch(/Suspended|suspended/);
  });
});

// ---------------------------------------------------------------------------

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The CLI as a caller meets it: a child process, argv, environment, exit code. */
function cli(argv: readonly string[], env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((settle) => {
    const child = execFile(
      process.execPath,
      [join(ROOT, 'dist/cli.js'), ...argv],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        settle({
          code: (error as { code?: number } | null)?.code ?? 0,
          stdout,
          stderr,
        });
      },
    );
    // Nothing is typed at it: every prompt this capability could raise is
    // answered from the environment instead.
    child.stdin?.end();
  });
}

const CREDENTIAL = { PASSWORD: 's3cret-teller' };

// @covers project.three-equal-surfaces
describe('run from the command line', () => {
  it('prints the answer as JSON and exits 0', async () => {
    const ran = await cli(
      ['--url', bundle.fixtures.clean.url, '--username', 'teller1', '--account-ref', 'ACC-1001'],
      CREDENTIAL,
    );

    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ status: 'ok', balance: 1250.75 });
  });

  it('does the same for a business outcome, because both are answers', async () => {
    const ran = await cli(
      ['--url', bundle.fixtures.clean.url, '--username', 'teller1', '--account-ref', 'ACC-9999'],
      CREDENTIAL,
    );

    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      status: 'account_not_found',
      accountRef: 'ACC-9999',
    });
  });

  it('sends a hard failure to stderr with the run id, and exits nonzero', async () => {
    const ran = await cli(
      [
        '--url',
        `${bundle.fixtures.clean.url}/?_fx=app-error`,
        '--username',
        'teller1',
        '--account-ref',
        'ACC-1001',
      ],
      CREDENTIAL,
    );

    expect(ran.code).not.toBe(0);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toMatch(/run:\s+run_/);
    expect(ran.stderr).toMatch(/step:\s+login\./);
  });
});

// @covers project.secret-refused-on-argv
describe('a secret on the command line', () => {
  it('is refused, and the value is taken from the environment instead', async () => {
    // argv lands in shell history and in process listings. The parser reads the
    // declaration to know which flag to refuse, which is why `secret()` is a
    // runtime marker rather than a type.
    const refused = await cli(
      [
        '--url',
        bundle.fixtures.clean.url,
        '--username',
        'teller1',
        '--account-ref',
        'ACC-1001',
        '--password',
        's3cret-teller',
      ],
      CREDENTIAL,
    );

    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--password is a secret');
    expect(refused.stderr).toContain('PASSWORD');
    // Refused before anything ran: no answer, and no run.
    expect(refused.stdout).toBe('');
  });

  it('never appears among the flags the usage lists', async () => {
    const help = await cli(['--help']);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--account-ref');
    expect(help.stdout).not.toContain('--password');
    expect(help.stdout).toContain('PASSWORD');
  });
});

// ---------------------------------------------------------------------------

interface Rpc {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { message: string };
}

/**
 * An MCP client, in as much of one as the claims need.
 *
 * Newline-delimited JSON-RPC over the child's stdio, because that is the whole
 * transport: the client launches the server as a child process, and there is no
 * listener, no port and no network surface.
 */
class Server {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #waiting = new Map<number, (message: Rpc) => void>();
  #buffer = '';
  #nextId = 1;

  constructor(root: string, env: Record<string, string>) {
    this.#child = spawn(process.execPath, [join(root, 'dist/mcp.js')], {
      env: { ...process.env, ...env },
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim() !== '') {
          const message = JSON.parse(line) as Rpc;
          this.#waiting.get(message.id)?.(message);
          this.#waiting.delete(message.id);
        }
        newline = this.#buffer.indexOf('\n');
      }
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<Rpc> {
    const id = this.#nextId++;
    return new Promise<Rpc>((settle) => {
      this.#waiting.set(id, settle);
      this.#child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  close(): void {
    this.#child.stdin.end();
    this.#child.kill();
  }
}

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { properties: Record<string, unknown>; required: readonly string[] };
  readonly outputSchema?: { oneOf: readonly { properties: { status: { const: string } } }[] };
}

interface CallResult {
  readonly content: readonly { readonly text: string }[];
  readonly structuredContent?: { readonly status: string };
  readonly isError?: boolean;
}

// @covers project.mcp-omits-secrets project.mcp-publishes-outcomes effects.published-to-the-caller
describe('served as a local MCP server', () => {
  let server: Server;

  beforeAll(() => {
    server = new Server(ROOT, CREDENTIAL);
  });

  afterAll(() => {
    server.close();
  });

  it('exposes exactly one tool, named for the capability', async () => {
    // One project is one capability. Aggregating several behind one server is
    // routing, and routing belongs above a generated project.
    const listed = await server.request('tools/list');
    const tools = (listed.result as { tools: Tool[] }).tools;

    expect(tools.map((tool) => tool.name)).toEqual(['checkAccountBalance']);
  });

  it('publishes the inputs without the credential', async () => {
    const listed = await server.request('tools/list');
    const [tool] = (listed.result as { tools: Tool[] }).tools;

    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      'url',
      'username',
      'accountRef',
    ]);
    // A calling agent has no business holding operator credentials, and a schema
    // that asks for a password invites exactly that.
    expect(tool?.inputSchema.properties).not.toHaveProperty('password');
    expect(tool?.description).toContain('PASSWORD');
  });

  it('publishes every declared answer, and the effects', async () => {
    const listed = await server.request('tools/list');
    const [tool] = (listed.result as { tools: Tool[] }).tools;

    expect(tool?.outputSchema?.oneOf.map((arm) => arm.properties.status.const)).toEqual([
      'account_not_found',
      'permission_denied',
      'ok',
    ]);
    expect(tool?.description).toContain('mutates read');
  });

  it('returns a business outcome as a normal result', async () => {
    // An exception crossing this boundary becomes an opaque tool error, and the
    // calling agent can no longer tell "this account does not exist" from "the
    // application is broken".
    const called = await server.request('tools/call', {
      name: 'checkAccountBalance',
      arguments: {
        url: bundle.fixtures.clean.url,
        username: 'teller1',
        accountRef: 'ACC-9999',
      },
    });
    const result = called.result as unknown as CallResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      status: 'account_not_found',
      accountRef: 'ACC-9999',
    });
  });

  it('sets isError only for a hard failure', async () => {
    const called = await server.request('tools/call', {
      name: 'checkAccountBalance',
      arguments: {
        url: `${bundle.fixtures.clean.url}/?_fx=app-error`,
        username: 'teller1',
        accountRef: 'ACC-1001',
      },
    });
    const result = called.result as unknown as CallResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/run run_/);
  });
});

describe('an attended capability, served the same way', () => {
  let server: Server;

  beforeAll(() => {
    server = new Server(ATTENDED_ROOT, CREDENTIAL);
  });

  afterAll(() => {
    server.close();
  });

  it('exposes a resume tool beside it, because a tool cannot call back', async () => {
    const listed = await server.request('tools/list');
    const tools = (listed.result as { tools: Tool[] }).tools;

    expect(tools.map((tool) => tool.name)).toEqual(['checkAccountBalance', 'resume']);
    expect(tools[0]?.description).toContain('stops to ask a human');
  });

  it('returns suspended as an answer, and resume carries the run on', async () => {
    const called = await server.request('tools/call', {
      name: 'checkAccountBalance',
      arguments: {
        url: bundle.fixtures.clean.url,
        username: 'teller1',
        accountRef: 'ACC-1001',
      },
    });
    const suspended = (called.result as unknown as CallResult).structuredContent as unknown as {
      status: string;
      sessionId: string;
      request: { kind: string; name: string };
    };

    expect(suspended.status).toBe('suspended');
    expect(suspended.request).toMatchObject({ kind: 'input', name: 'mfaCode' });

    const resumed = await server.request('tools/call', {
      name: 'resume',
      arguments: { sessionId: suspended.sessionId, response: '123456' },
    });

    expect((resumed.result as unknown as CallResult).structuredContent).toEqual({ status: 'ok' });
  });
});
