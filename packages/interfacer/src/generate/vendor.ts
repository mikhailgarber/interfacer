/**
 * The DSL, copied into the project.
 *
 * A generated project has to run from wherever somebody puts it, and
 * `@interfacer/dsl` is not published to a registry — so naming it as a
 * dependency means naming a path back into an Interfacer checkout, which is a
 * project that only works where it was made. Generation copies the built package
 * in instead, and the emitted `package.json` depends on that copy.
 *
 * The **built** package rather than its source, deliberately. What a capability
 * may do is bounded by what the DSL offers, and the design says that bound is
 * structural rather than a matter of review discipline; source in the project,
 * compiled by the project, would put the allowlist check and the redaction rules
 * one edit away from an owner who never meant to weaken them.
 *
 * The cost is real and worth stating where it is paid: a fix in the DSL reaches
 * an existing capability only by regenerating it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Where the copy lives inside the generated project. */
export const VENDOR_DIR = 'vendor/interfacer-dsl';

/** What the emitted `package.json` names as the dependency. */
export const VENDOR_SPEC = `file:./${VENDOR_DIR}`;

/**
 * What gets copied: the emitted JavaScript and its declarations.
 *
 * Source maps are left behind. They point at `../src/*.ts`, which is not part of
 * the published package and is not part of the copy either, so shipping them
 * would only produce a debugger that opens files nobody has.
 */
function isCopied(name: string): boolean {
  return name.endsWith('.js') || (name.endsWith('.d.ts') && !name.endsWith('.d.ts.map'));
}

/**
 * Drop the trailing `sourceMappingURL` comment.
 *
 * The maps are not copied, and a reference to a map that is not there is not
 * inert: Node and every test runner that reads them report the missing file on
 * every load, which turns a clean run into a wall of errors about a file nobody
 * asked for.
 */
function withoutMapReference(contents: string): string {
  return contents.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
}

interface DslManifest {
  readonly name: string;
  readonly version: string;
  readonly type?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly engines?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** The installed DSL's own root, found the way Node finds it. */
function dslRoot(): string {
  const require = createRequire(import.meta.url);
  // `main` is `dist/index.js`, so the package root is two levels up.
  return dirname(dirname(require.resolve('@interfacer/dsl')));
}

/**
 * The vendored package, as files.
 *
 * Its `package.json` is the DSL's own with the fields that describe *developing*
 * it dropped — `files`, `scripts`, `devDependencies` — and its dependencies kept
 * verbatim, so the project's own install pulls Playwright exactly as an install
 * from a registry would have.
 */
export async function vendoredDsl(): Promise<ReadonlyMap<string, string>> {
  const root = dslRoot();
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as DslManifest;

  const files = new Map<string, string>();

  files.set(
    `${VENDOR_DIR}/package.json`,
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        description: 'Vendored by Interfacer: the engine this capability was recorded against.',
        ...(manifest.type === undefined ? {} : { type: manifest.type }),
        ...(manifest.main === undefined ? {} : { main: manifest.main }),
        ...(manifest.types === undefined ? {} : { types: manifest.types }),
        ...(manifest.exports === undefined ? {} : { exports: manifest.exports }),
        ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
        dependencies: manifest.dependencies ?? {},
      },
      undefined,
      2,
    )}\n`,
  );

  const dist = join(root, 'dist');
  for (const name of (await readdir(dist)).filter(isCopied)) {
    files.set(
      `${VENDOR_DIR}/dist/${name}`,
      withoutMapReference(await readFile(join(dist, name), 'utf8')),
    );
  }

  if (files.size <= 1) {
    throw new Error(`@interfacer/dsl has no build at ${dist}: run the build before generating`);
  }

  return files;
}
