/**
 * Serving a fixture over real HTTP.
 *
 * A server rather than a stubbed page object, because the rules the engine
 * implements are about navigation, resolved URLs after redirect, session expiry
 * and multi-page flow — none of which exist without one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { handle, Sessions, type AppOptions } from './app.js';
import type { PageModel } from './model.js';
import { renderClean } from './render/clean.js';
import { renderHostile } from './render/hostile.js';
import { renderLegacy } from './render/legacy.js';
import { renderRebranded } from './render/rebranded.js';

export type Renderer = (model: PageModel) => string;

export const FIXTURE_NAMES = ['clean', 'legacy', 'hostile', 'rebranded', 'skewed'] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface Variant {
  readonly name: FixtureName;
  readonly render: Renderer;
  /** Split the detail screen in two — the one structural divergence. */
  readonly splitDetail: boolean;
  readonly summary: string;
}

export const VARIANTS: Readonly<Record<FixtureName, Variant>> = Object.freeze({
  clean: Object.freeze({
    name: 'clean' as const,
    render: renderClean,
    splitDetail: false,
    summary: 'semantic markup, roles, labels, test IDs',
  }),
  legacy: Object.freeze({
    name: 'legacy' as const,
    render: renderLegacy,
    splitDetail: false,
    summary: 'server-rendered, table layout, no test IDs',
  }),
  hostile: Object.freeze({
    name: 'hostile' as const,
    render: renderHostile,
    splitDetail: false,
    summary: 'nested tables, generated classes, mismatched names, duplicate labels',
  }),
  rebranded: Object.freeze({
    name: 'rebranded' as const,
    render: renderRebranded,
    splitDetail: false,
    summary: 'clean, restyled and reworded — same structure',
  }),
  // `skewed` is `clean`'s markup with the detail screen split in two. It looks
  // identical and is structurally different, which is exactly the difference the
  // design says earns its own artifact rather than being absorbed.
  skewed: Object.freeze({
    name: 'skewed' as const,
    render: renderClean,
    splitDetail: true,
    summary: 'clean, with the detail screen split across two pages',
  }),
});

export interface FixtureHandle {
  readonly name: string;
  /** e.g. `http://127.0.0.1:41235` — no trailing slash. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  /**
   * Which interface to bind. The default matters: the fixtures bind
   * `127.0.0.1` and the offsite server binds `localhost`, so that — although
   * both are loopback — they are different **hosts**, which is the unit the
   * allowlist works in.
   */
  readonly host?: string;
  /** `0` asks the OS for a free port, which is what keeps parallel tests apart. */
  readonly port?: number;
}

export const FIXTURE_HOST = '127.0.0.1';
export const OFFSITE_HOST = 'localhost';

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server did not bind a TCP port');
  }

  return (address satisfies AddressInfo).port;
}

function closer(server: Server): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      // Without this, a keep-alive connection from a previous request holds the
      // process open and `npm run fixtures` appears to hang on Ctrl-C.
      server.closeAllConnections();
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
}

/**
 * A second host, so a redirect can genuinely leave the allowlist.
 *
 * Bound on `127.0.0.1` but advertised as `localhost`. Those are the same
 * interface and two different **hosts**, which is the unit the allowlist works
 * in — so a fixture on `127.0.0.1` can redirect somewhere genuinely off-list
 * without leaving loopback or depending on DNS.
 *
 * The bind address is pinned rather than left as `localhost` because resolving
 * that name may pick `::1` while a client picks `127.0.0.1`, and the connection
 * then fails for a reason that has nothing to do with what is being tested.
 */
export async function startOffsite(options: StartOptions = {}): Promise<FixtureHandle> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html>\n<html lang="en"><body><p>Offsite.</p></body></html>\n');
  });

  const port = await listen(server, FIXTURE_HOST, options.port ?? 0);
  const advertised = options.host ?? OFFSITE_HOST;

  return { name: 'offsite', url: `http://${advertised}:${port}`, port, close: closer(server) };
}

export async function startFixture(
  name: FixtureName,
  offsiteUrl: string,
  options: StartOptions = {},
): Promise<FixtureHandle> {
  const variant = VARIANTS[name];
  const sessions = new Sessions();
  const appOptions: AppOptions = { splitDetail: variant.splitDetail, offsiteUrl };

  const server = createServer((request, response) => {
    void serve(request, response);
  });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { response: result, delayMs } = handle(
      {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers as Record<string, string | undefined>,
        body: request.method === 'POST' ? await readBody(request) : '',
      },
      sessions,
      appOptions,
    );

    // A slow but successful response. Bounded and deliberate, so "loaded
    // slowly" and "never loaded" stay distinguishable — which is the whole
    // reason waiting is a predicate and never a sleep.
    await delay(delayMs);

    switch (result.kind) {
      case 'redirect':
        response.writeHead(302, {
          location: result.location,
          ...(result.setCookie === undefined ? {} : { 'set-cookie': result.setCookie }),
        });
        response.end();
        return;

      case 'text':
        response.writeHead(result.status, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(result.body);
        return;

      case 'page':
        response.writeHead(result.status, {
          'content-type': 'text/html; charset=utf-8',
          // No caching, so a replay always reaches the application rather than
          // a stale copy of an earlier screen.
          'cache-control': 'no-store',
        });
        response.end(variant.render(result.model));
    }
  }

  const host = options.host ?? FIXTURE_HOST;
  const port = await listen(server, host, options.port ?? 0);

  return { name, url: `http://${host}:${port}`, port, close: closer(server) };
}

export interface FixtureBundle {
  readonly fixtures: Readonly<Record<FixtureName, FixtureHandle>>;
  /** The off-allowlist host every fixture's `/offsite` redirects to. */
  readonly offsite: FixtureHandle;
  closeAll(): Promise<void>;
}

/**
 * Start every fixture plus the offsite host.
 *
 * `basePort` of `0` (the default) takes ephemeral ports, which is what lets
 * test files run in parallel workers without colliding. The serve script passes
 * a real base port, because a person wants a URL that stays put.
 */
export async function startAll(options: { basePort?: number } = {}): Promise<FixtureBundle> {
  const basePort = options.basePort ?? 0;
  const started: FixtureHandle[] = [];

  try {
    const offsite = await startOffsite(basePort === 0 ? {} : { port: basePort });
    started.push(offsite);

    const entries: [FixtureName, FixtureHandle][] = [];
    for (const [index, name] of FIXTURE_NAMES.entries()) {
      const handle = await startFixture(
        name,
        `${offsite.url}/collect`,
        basePort === 0 ? {} : { port: basePort + index + 1 },
      );
      started.push(handle);
      entries.push([name, handle]);
    }

    return {
      fixtures: Object.fromEntries(entries) as Record<FixtureName, FixtureHandle>,
      offsite,
      closeAll: async () => {
        await Promise.all(started.map((handle) => handle.close()));
      },
    };
  } catch (error) {
    // A partial start leaves listening sockets behind, which would make the
    // next attempt fail for the wrong reason.
    await Promise.all(started.map((handle) => handle.close()));
    throw error;
  }
}
