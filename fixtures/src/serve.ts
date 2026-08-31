#!/usr/bin/env node
/**
 * `npm run fixtures` — start the fixtures and hold, so a person can open one.
 *
 * Not a convenience. These apps stand in for the back-office systems Interfacer
 * targets, and how tractable each one is — what `byRole` finds, where the
 * accessibility tree gives out, whether a screen reads as genuinely hostile — is
 * a judgement someone has to make by looking at it. It is also the fastest way
 * to check that a `rebranded` restyle really did leave the structure alone.
 *
 * These are the same servers the tests use, started the same way, so there is no
 * second code path to drift.
 *
 *   npm run fixtures
 *   npm run fixtures -- hostile
 *   npm run fixtures -- --port 4100
 */
import { FIXTURE_NAMES, startAll, startFixture, startOffsite, VARIANTS } from './server.js';
import type { FixtureHandle, FixtureName } from './server.js';

const DEFAULT_BASE_PORT = 4000;

interface Args {
  readonly only: FixtureName | undefined;
  readonly basePort: number;
}

export function parseArgs(argv: readonly string[]): Args {
  let only: FixtureName | undefined;
  let basePort = DEFAULT_BASE_PORT;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === '--port' || argument === '-p') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error(`--port needs a port number, got ${String(argv[index + 1])}`);
      }
      basePort = value;
      index++;
      continue;
    }

    if (argument !== undefined && (FIXTURE_NAMES as readonly string[]).includes(argument)) {
      only = argument as FixtureName;
      continue;
    }

    throw new Error(
      `unknown argument ${String(argument)}. ` +
        `Expected one of ${FIXTURE_NAMES.join(', ')}, or --port <n>.`,
    );
  }

  return { only, basePort };
}

function report(handles: readonly FixtureHandle[], offsite: FixtureHandle): void {
  const width = Math.max(...handles.map((handle) => handle.name.length));

  process.stdout.write('\nFixtures are up. Ctrl-C to stop.\n\n');

  for (const handle of handles) {
    const variant = VARIANTS[handle.name as FixtureName];
    process.stdout.write(`  ${handle.name.padEnd(width)}  ${handle.url}  — ${variant.summary}\n`);
  }

  process.stdout.write(`\n  ${'offsite'.padEnd(width)}  ${offsite.url}  `);
  process.stdout.write('— a different host, for the off-allowlist redirect\n');

  process.stdout.write('\nSign in with teller1 / s3cret-teller, or viewer1 / s3cret-viewer.\n');
  process.stdout.write('Accounts ACC-1001 and ACC-1002 exist; ACC-2002 needs the TELLER role;\n');
  process.stdout.write('ACC-9999 does not exist.\n\n');
  process.stdout.write('Ask any page for an exceptional condition with a query parameter:\n');
  process.stdout.write(
    '  ?_fx=slow&_ms=800   ?_fx=dialog   ?_fx=session-expired   ?_fx=app-error\n\n',
  );
}

export async function main(argv: readonly string[]): Promise<void> {
  const { only, basePort } = parseArgs(argv);

  const started = only === undefined ? await startEvery(basePort) : await startOne(only, basePort);

  report(started.handles, started.offsite);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.stdout.write('\nStopping fixtures…\n');
      void started.closeAll().then(resolve, resolve);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

interface Started {
  readonly handles: readonly FixtureHandle[];
  readonly offsite: FixtureHandle;
  closeAll(): Promise<void>;
}

async function startEvery(basePort: number): Promise<Started> {
  const bundle = await startAll({ basePort });

  return {
    handles: FIXTURE_NAMES.map((name) => bundle.fixtures[name]),
    offsite: bundle.offsite,
    closeAll: async () => {
      await bundle.closeAll();
    },
  };
}

async function startOne(name: FixtureName, basePort: number): Promise<Started> {
  const offsite = await startOffsite(basePort === 0 ? {} : { port: basePort });
  const handle = await startFixture(
    name,
    `${offsite.url}/collect`,
    basePort === 0 ? {} : { port: basePort + 1 },
  );

  return {
    handles: [handle],
    offsite,
    closeAll: async () => {
      await Promise.all([handle.close(), offsite.close()]);
    },
  };
}

// Run only when invoked directly, so the test can import `parseArgs` without
// starting a server.
if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
