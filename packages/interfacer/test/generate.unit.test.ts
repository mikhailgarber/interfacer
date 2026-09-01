import {
  answer,
  byRole,
  css,
  DEFAULT_EFFECTS,
  field,
  fields,
  Flow,
  secret,
  text,
} from '@interfacer/dsl';
import { generateProject, GenerationRefused, UnprintableFlow } from 'interfacer';
import { describe, expect, it } from 'vitest';

import { balanceCapability, variant } from './capability.js';

/**
 * What generation emits, and what it refuses to emit at all.
 *
 * The refusals are the half worth being careful about: each one is a
 * contradiction in the artifact rather than a condition of a run, so catching it
 * here catches it once instead of once per run — and the capability that would
 * have violated it never exists.
 */

const REQUEST = {
  packageName: 'mybank-balance',
  description: 'Read an account balance from the back office.',
  variant,
} as const;

const input = fields({ url: text(), password: secret() });

/** What the project itself is made of, as against the engine copied in beside it. */
function authored(files: ReadonlyMap<string, string>): string[] {
  return [...files.keys()].filter((path) => !path.startsWith('vendor/')).sort();
}

// @covers artifact.no-serialized-form
describe('what a project is made of', () => {
  it('is source and its build configuration, and nothing describing the steps', async () => {
    const files = await generateProject({ ...REQUEST, flow: balanceCapability() });

    expect(authored(files)).toEqual([
      'README.md',
      'package.json',
      'src/cli.ts',
      'src/contract.ts',
      'src/flow.ts',
      'src/index.ts',
      'src/mcp.ts',
      'src/variant.ts',
      'tsconfig.json',
    ]);

    // The two JSON files configure a build; neither is a manifest, a step file
    // or an exported description. The source is the artifact, and a normalized
    // data form would only be a second copy of the same facts.
    const flow = files.get('src/flow.ts') ?? '';
    expect(flow).toContain(".pressButton([byRole('button', 'Sign in')], { id: 'login.submit' })");
    expect(files.get('package.json')).not.toContain('steps');
  });
});

describe('the engine the project carries', () => {
  it('is the built DSL, copied in, so the project runs from anywhere', async () => {
    // `@interfacer/dsl` is not published, so naming it as a dependency would mean
    // naming a path back into an Interfacer checkout — a project that only works
    // where it was made.
    const files = await generateProject({ ...REQUEST, flow: balanceCapability() });
    const manifest = JSON.parse(files.get('package.json') ?? '{}') as {
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies['@interfacer/dsl']).toBe('file:./vendor/interfacer-dsl');
    expect(files.get('vendor/interfacer-dsl/dist/index.js')).toBeDefined();
    expect(files.get('vendor/interfacer-dsl/dist/index.d.ts')).toBeDefined();

    // Built output, not source: what a capability may do is bounded by what the
    // DSL offers, and source compiled by the project would put the allowlist
    // check and the redaction rules one edit away.
    expect(files.get('vendor/interfacer-dsl/dist/engine.js')).toBeDefined();
    expect([...files.keys()]).not.toContain('vendor/interfacer-dsl/src/engine.ts');
  });

  it("carries the copied package's own dependencies, so the install is ordinary", async () => {
    const files = await generateProject({ ...REQUEST, flow: balanceCapability() });
    const vendored = JSON.parse(files.get('vendor/interfacer-dsl/package.json') ?? '{}') as {
      name: string;
      dependencies: Record<string, string>;
    };

    expect(vendored.name).toBe('@interfacer/dsl');
    // Playwright comes from the registry exactly as it would have for a package
    // installed from one. Vendoring the DSL bounds where the *DSL* comes from,
    // and claims nothing about the rest of the graph.
    expect(vendored.dependencies).toHaveProperty('playwright');
  });

  it('leaves the source maps behind, and the references to them', async () => {
    // A map points at `../src/*.ts`, which is in neither the published package
    // nor the copy, so shipping one produces a debugger that opens files nobody
    // has — and a dangling reference is reported on every load.
    const files = await generateProject({ ...REQUEST, flow: balanceCapability() });

    expect([...files.keys()].filter((path) => path.endsWith('.map'))).toEqual([]);
    expect(files.get('vendor/interfacer-dsl/dist/index.js')).not.toContain('sourceMappingURL');
  });
});

// @covers artifact.version-is-the-project components.no-sdk-at-replay
describe('what a project depends on', () => {
  it('needs the DSL and nothing else at run time', async () => {
    const files = await generateProject({ ...REQUEST, flow: balanceCapability() });
    const manifest = JSON.parse(files.get('package.json') ?? '{}') as {
      dependencies: Record<string, string>;
      version: string;
    };

    // A capability in production never loads a model SDK and never needs an API
    // key. That is a property of what generation writes down, so it is checked
    // where it is written down.
    expect(Object.keys(manifest.dependencies)).toEqual(['@interfacer/dsl']);
    for (const contents of files.values()) {
      expect(contents).not.toContain('@anthropic-ai');
      expect(contents).not.toContain('API_KEY');
    }
  });

  it('takes its version from the package, with no second number in the flow', async () => {
    const files = await generateProject({
      ...REQUEST,
      flow: balanceCapability(),
      version: '2.4.0',
    });

    expect(JSON.parse(files.get('package.json') ?? '{}')).toMatchObject({ version: '2.4.0' });
    // Read at run time from the one place it is stated. A hand-maintained number
    // beside a real one only drifts from it.
    expect(files.get('src/index.ts')).toContain("readFileSync(new URL('../package.json'");
    expect(files.get('src/flow.ts')).not.toContain('version');
  });
});

// @covers effects.read-may-not-commit
describe('a capability that says it only reads', () => {
  it('is refused generation if it contains the point of no return', async () => {
    // Hosts bound where the automation may go; `mutates` bounds what it may do
    // once there. Rejected here rather than at replay, because it is a
    // contradiction in the declaration rather than a condition of a run.
    const readOnly = new Flow({
      id: 'looksButAlsoTouches',
      input,
      effects: { ...DEFAULT_EFFECTS, mutates: 'read' },
    })
      .open(field('url'), { id: 'open' })
      .commit([byRole('button', 'Confirm')], { id: 'the.commit' })
      .returns(answer('ok'));

    await expect(generateProject({ ...REQUEST, flow: readOnly })).rejects.toBeInstanceOf(
      GenerationRefused,
    );
    await expect(generateProject({ ...REQUEST, flow: readOnly })).rejects.toThrow(/the\.commit/);
  });

  it('is generated where it only reads', async () => {
    await expect(generateProject({ ...REQUEST, flow: balanceCapability() })).resolves.toBeDefined();
  });
});

// @covers generation.refuses-an-unprintable-flow
describe('a flow written with plain closures', () => {
  it('is refused by name rather than approximated', async () => {
    // It runs perfectly well. What it cannot do is be printed back into source:
    // the closure's text is not recoverable in general, and where it is
    // recoverable it is wrong, because what it captured is not in the file.
    const handWritten = new Flow({ id: 'handWritten', input })
      .open((i) => i.url, { id: 'login.open' })
      .returns(answer('ok'));

    await expect(generateProject({ ...REQUEST, flow: handWritten })).rejects.toBeInstanceOf(
      UnprintableFlow,
    );
    await expect(generateProject({ ...REQUEST, flow: handWritten })).rejects.toThrow(
      /login\.open.*field\(\)/s,
    );
  });

  it('names the step, not the flow, so the fix has an address', async () => {
    const mixed = new Flow({ id: 'mixed', input })
      .open(field('url'), { id: 'login.open' })
      .fillForm([css('#password')], (i) => i.password, { id: 'login.password' })
      .returns(answer('ok'));

    await expect(generateProject({ ...REQUEST, flow: mixed })).rejects.toThrow(/login\.password/);
  });
});

describe('a capability id that is not an identifier', () => {
  it('is refused, because the id names the exported master function', async () => {
    const awkward = new Flow({ id: 'check account balance', input })
      .open(field('url'), { id: 'login.open' })
      .returns(answer('ok'));

    await expect(generateProject({ ...REQUEST, flow: awkward })).rejects.toThrow(
      /not a plain identifier/,
    );
  });
});
