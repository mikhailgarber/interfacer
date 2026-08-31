import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { FIXTURE_NAMES } from '@interfacer/fixtures';

/**
 * `npm run fixtures`, tested by running it.
 *
 * The script exists so a person can open a fixture and look at it — which is
 * how `hostile` gets to be genuinely hostile rather than hostile-by-assertion,
 * and the fastest way to check a `rebranded` restyle left the structure alone.
 * A script nobody can trust to start is no use for that, so the claim here is
 * the one that matters in practice: it starts, every URL it prints is
 * reachable, and Ctrl-C actually stops it.
 *
 * Ports are ephemeral (`--port 0`), so running this never collides with a
 * fixture server somebody has open in a browser.
 */

const SERVE = fileURLToPath(new URL('../dist/serve.js', import.meta.url));

let child: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  if (child?.exitCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
});

interface Started {
  readonly process: ChildProcessWithoutNullStreams;
  readonly output: () => string;
  readonly urls: readonly string[];
}

function urlsIn(output: string): string[] {
  return [...output.matchAll(/http:\/\/[^\s]+/g)].map((match) => match[0]);
}

async function start(args: readonly string[], expectedUrls: number): Promise<Started> {
  const spawned = spawn(process.execPath, [SERVE, ...args], { stdio: 'pipe' });
  child = spawned;

  let output = '';
  spawned.stdout.setEncoding('utf8');
  const collect = (chunk: string): void => {
    output += chunk;
  };
  spawned.stdout.on('data', collect);
  spawned.stderr.setEncoding('utf8');
  spawned.stderr.on('data', collect);

  const deadline = Date.now() + 20_000;
  while (urlsIn(output).length < expectedUrls) {
    if (spawned.exitCode !== null) {
      throw new Error(`serve exited early (${String(spawned.exitCode)}):\n${output}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`serve did not report ${String(expectedUrls)} URLs:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return { process: spawned, output: () => output, urls: urlsIn(output) };
}

function exitOf(spawned: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    spawned.once('exit', (code) => {
      resolve(code);
    });
  });
}

describe('npm run fixtures', () => {
  it('starts every fixture and the offsite host, and each URL is reachable', async () => {
    // Five fixtures plus the offsite host.
    const started = await start(['--port', '0'], FIXTURE_NAMES.length + 1);

    expect(started.urls).toHaveLength(FIXTURE_NAMES.length + 1);

    const responses = await Promise.all(
      started.urls.map((url) => fetch(url, { redirect: 'manual' })),
    );

    for (const [index, response] of responses.entries()) {
      // Reachable, not merely printed. A URL in the output that nothing is
      // listening on is the failure this is here to catch.
      expect(response.status, started.urls[index]).toBeLessThan(400);
    }

    started.process.kill('SIGINT');
    expect(await exitOf(started.process)).toBe(0);
  });

  it('names each fixture beside its URL, so a reader knows which is which', async () => {
    const started = await start(['--port', '0'], FIXTURE_NAMES.length + 1);

    for (const name of FIXTURE_NAMES) {
      expect(started.output()).toContain(name);
    }

    // The credentials and the account references, because a person opening
    // these has no other way to get past the login screen.
    expect(started.output()).toContain('teller1');
    expect(started.output()).toContain('ACC-1001');

    started.process.kill('SIGINT');
    await exitOf(started.process);
  });

  it('shuts every server down on interrupt, releasing the ports', async () => {
    const started = await start(['--port', '0'], FIXTURE_NAMES.length + 1);
    const [first] = started.urls;

    started.process.kill('SIGINT');
    expect(await exitOf(started.process)).toBe(0);

    // Exiting cleanly is not the same as having closed the listeners: a
    // keep-alive connection can hold a socket open past the handler returning.
    await expect(fetch(first ?? '', { redirect: 'manual' })).rejects.toThrow();
  });

  it('starts just one fixture when asked for one', async () => {
    const started = await start(['hostile', '--port', '0'], 2);

    expect(started.output()).toContain('hostile');
    expect(started.output()).not.toContain('rebranded');

    started.process.kill('SIGINT');
    await exitOf(started.process);
  });

  it('refuses an argument it does not understand, rather than starting anyway', async () => {
    const spawned = spawn(process.execPath, [SERVE, 'not-a-fixture'], { stdio: 'pipe' });
    child = spawned;

    let stderr = '';
    spawned.stderr.setEncoding('utf8');
    spawned.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    expect(await exitOf(spawned)).toBe(1);
    expect(stderr).toContain('not-a-fixture');
    // Naming the alternatives, because the whole point of the script is that
    // somebody is using it interactively.
    expect(stderr).toContain('clean');
  });
});
