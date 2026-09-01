import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Where the SDK is allowed to be.
 *
 * Provider portability is a seam, not an abstraction layer: moving to another
 * provider means rewriting one module. That is only true while one module is the
 * only one that imports the SDK, and nothing but a reading of the source can say
 * whether it still is — a mock would assert that the seam was called, not that
 * it is the only door.
 */

const SDK = '@anthropic-ai/sdk';

function sources(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(root, name));
}

function importers(root: string): readonly string[] {
  return sources(root).filter((path) => readFileSync(path, 'utf8').includes(SDK));
}

// @covers agent.one-sdk-seam
describe('the model SDK', () => {
  it('is imported by exactly one module', () => {
    expect(importers('packages/interfacer/src')).toEqual([
      'packages/interfacer/src/agent/decide.ts',
    ]);
  });

  it('is not reachable from the DSL at all', () => {
    // The DSL knows nothing about Interfacer, the agent loop, or any model —
    // which is why a capability in production never loads an SDK and never
    // needs an API key. It is also vendored into every generated project, so
    // an import here would ship to every capability.
    expect(importers('packages/dsl/src')).toEqual([]);
  });
});

// @covers components.no-sdk-at-replay
describe('a discovery-time credential', () => {
  it('is named without a provider, and read from the environment', async () => {
    const { credentials, MissingCredential, DEFAULT_MODEL } = await import('interfacer');

    // Checked before a browser opens or the first question is asked, so a
    // missing key costs a second rather than an entire interview.
    expect(() => credentials({})).toThrow(MissingCredential);
    expect(() => credentials({ API_KEY: '' })).toThrow(/API_KEY/);
    expect(credentials({ API_KEY: 'k' })).toEqual({ apiKey: 'k', model: DEFAULT_MODEL });
    expect(credentials({ API_KEY: 'k', MODEL: 'claude-sonnet-5' }).model).toBe('claude-sonnet-5');
  });
});
