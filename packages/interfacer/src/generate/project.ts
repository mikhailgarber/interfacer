/**
 * The emitted project: one capability, three surfaces, no model.
 *
 * Generation returns a path → contents map rather than writing files, so what
 * was emitted can be asserted on directly and writing is a separate, trivial
 * step. The map is the whole project: it compiles and runs with nothing added.
 *
 * Only `src/flow.ts` is genuinely synthesized. `src/contract.ts` copies out the
 * declarations the interview produced, and the CLI and MCP entry points are the
 * same source in every project — they read `inputFields`, `effects` and the
 * flow's declared answers at run time rather than having a schema baked into
 * them, which is the rule that keeps one declaration from acquiring a second
 * copy free to drift from it.
 */
import {
  interactionsOf,
  isAttended,
  requiresApproval,
  type FieldSet,
  type Flow,
  type VariantStamp,
} from '@interfacer/dsl';
import { format } from 'prettier';

import { Imports, printEffects, printFields, printFlow, quote } from './print.js';
import { CAPABILITY, CLI_TEMPLATE, DESCRIPTION, MCP_TEMPLATE, PACKAGE } from './templates.js';
import { vendoredDsl, VENDOR_SPEC } from './vendor.js';

export interface GenerateRequest {
  readonly flow: Flow<FieldSet, unknown>;
  /** The npm package name, and what `npx` runs. Distinct from the capability id. */
  readonly packageName: string;
  /** One line, published in the MCP tool description and the generated README. */
  readonly description: string;
  readonly variant: VariantStamp;
  readonly version?: string;
}

/** Path relative to the project root → file contents. */
export type ProjectFiles = ReadonlyMap<string, string>;

/**
 * A capability id has to be a plain identifier, because it names the master
 * function a caller imports.
 */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class GenerationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * What may not be emitted at all.
 *
 * Generation-time rather than replay-time, deliberately: these are properties of
 * the artifact, so catching them here catches them once instead of once per run,
 * and the capability that would have violated one never exists.
 */
function refuseImpossible(request: GenerateRequest): void {
  const { flow } = request;

  if (!IDENTIFIER.test(flow.id)) {
    throw new GenerationRefused(
      `capability id ${JSON.stringify(flow.id)} is not a plain identifier, and it names the exported master function`,
    );
  }

  if (flow.effects.mutates === 'read' && flow.steps.some((step) => step.kind === 'commit')) {
    // Hosts bound where the automation may go; `mutates` bounds what it may do
    // once there. A capability that says it only reads and contains the point of
    // no return is not a run to be refused later — it is a contradiction in the
    // declaration.
    const commit = flow.steps.find((step) => step.kind === 'commit');
    throw new GenerationRefused(
      `capability ${flow.id} declares mutates: 'read' and contains a .commit() at ${String(commit?.id)}`,
    );
  }
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2023"],
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`;

function packageJson(request: GenerateRequest): string {
  return `${JSON.stringify(
    {
      name: request.packageName,
      version: request.version ?? '0.1.0',
      description: request.description,
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      bin: { [request.packageName]: './dist/cli.js' },
      scripts: { build: 'tsc', mcp: 'node dist/mcp.js' },
      engines: { node: '>=22.11' },
      // The copy inside the project, so the project runs from wherever it is
      // put. Nothing here names a path outside itself.
      dependencies: { '@interfacer/dsl': VENDOR_SPEC },
      devDependencies: { '@types/node': '^22.20.0', typescript: '~6.0.0' },
    },
    undefined,
    2,
  )}\n`;
}

function contract(request: GenerateRequest): string {
  const imports = new Imports();
  const fields = printFields(request.flow.input, imports);
  const effects = printEffects(request.flow.effects);
  imports.useType('Infer');

  return `/**
 * The capability's contract, declared once as values.
 *
 * The compiler checks the master function against \`Input\`; the CLI parser, the
 * MCP tool schema and the generated documentation read these same declarations
 * at run time. There is no second representation to keep in step.
 */
${imports.statements('@interfacer/dsl')}

export const inputFields = ${fields};

export type Input = Infer<typeof inputFields>;

/** What this capability does. Published so a caller sees it before invoking. */
export const effects = ${effects};
`;
}

function flowModule(request: GenerateRequest): string {
  const imports = new Imports();
  const body = printFlow(request.flow, imports);

  return `/**
 * The capability itself: the recorded steps, in the order they were verified
 * against the application.
 *
 * Emitted by Interfacer from what discovery actually did — acting and recording
 * are one operation, so nothing here is a description of a run that happened
 * somewhere else. Every step carries the id the run record refers to.
 */
${imports.statements('@interfacer/dsl')}

import { effects, inputFields } from './contract.js';

${body}
`;
}

function variantModule(request: GenerateRequest): string {
  const { variant } = request;
  const lines = [
    `  capability: ${quote(variant.capability)},`,
    ...(variant.vendor === undefined ? [] : [`  vendor: ${quote(variant.vendor)},`]),
    ...(variant.appVersion === undefined ? [] : [`  appVersion: ${quote(variant.appVersion)},`]),
    `  recordedAgainst: ${quote(variant.recordedAgainst)},`,
    `  recordedOn: ${quote(variant.recordedOn)},`,
  ];

  return `/**
 * What this project was recorded against.
 *
 * Not a runtime check: the entry point is an input, so one artifact serving many
 * hosts is the intended behaviour and a host difference is normal rather than a
 * signal. It is a diagnosis. When a run reports drift, this says what the
 * artifact was built against, which is what makes the cause findable — a field
 * nobody thought to edit when they copied the project and changed the URL.
 *
 * A field nobody knows is absent rather than guessed: a fabricated version reads
 * as fact.
 */
export const variant = {
${lines.join('\n')}
} as const;
`;
}

function indexModule(request: GenerateRequest): string {
  const { flow } = request;
  const attended = isAttended(flow);
  const interactions = interactionsOf(flow);

  const interactionLines = Object.entries(interactions).map(
    ([name, declaration]) =>
      `  ${JSON.stringify(name)}: { kind: ${quote(declaration.kind)}, name: ${quote(
        declaration.name,
      )}, prompt: ${quote(declaration.prompt)}, secret: ${String(declaration.secret)} },`,
  );

  return `/**
 * The master function, and the contract around it.
 *
 * One function serves all three surfaces — the command line, an ordinary import,
 * and the MCP server — and none of them is a wrapper around another. What
 * differs between them is only how an answer, a suspension and a thrown failure
 * map onto that surface's conventions.
 */
import { readFileSync } from 'node:fs';

import {
  resume as resumeRun,
  runFlow,
  type AnswerOf,
  type InteractionDeclaration,
  type InteractionResponse,
  type Resolver,
  type RunOptions,
  type Suspended,
} from '@interfacer/dsl';

import { effects, inputFields, type Input } from './contract.js';
import { flow } from './flow.js';
import { variant } from './variant.js';

export { effects, inputFields, variant, flow };
export type { Input };

export {
  ApprovalDenied,
  CheckpointFailed,
  EffectsRefused,
  InteractionFailed,
  isReplayError,
  isSuspended,
  NavigationBlocked,
  PauseExpired,
  ReplayError,
  SessionExpired,
  SurfaceUnavailable,
  TargetAmbiguous,
  UnknownSession,
  type InteractionRequest,
  type InteractionResponse,
  type Resolver,
  type Suspended,
} from '@interfacer/dsl';

/** Every answer this capability can give: success, and each declared outcome. */
export type Answer = AnswerOf<typeof flow>;

/**
 * The pauses this capability declares, so a caller knows before invoking that it
 * will stop and ask.
 *
 * Whether it needs an attended session is not declared separately — it is
 * whether this is non-empty.
 */
export const interactions: Readonly<Record<string, InteractionDeclaration>> = {
${interactionLines.join('\n')}
};

export const attended = ${String(attended)};

/** The capability's version is the project's. There is no second number. */
export const version: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** Everything a caller may decide about a run. The version and phase are ours. */
export type CallOptions = Omit<RunOptions, 'capabilityVersion' | 'phase'>;

// A resolver is supplied: the engine asks and loops internally, so the run never
// suspends and the caller never handles the arm.
export function ${flow.id}(
  input: Input,
  options: CallOptions & { readonly resolver: Resolver },
): Promise<Answer>;
// No resolver: there is nowhere to ask, so the run parks and says so.
export function ${flow.id}(input: Input, options?: CallOptions): Promise<Answer | Suspended>;
export function ${flow.id}(
  input: Input,
  options: CallOptions = {},
): Promise<Answer | Suspended> {
  return runFlow(flow, input, { ...options, capabilityVersion: version });
}

/** Answer a parked run. Single-shot: a second call on the same id is an error. */
export function resume(
  sessionId: string,
  response: InteractionResponse,
): Promise<Answer | Suspended> {
  return resumeRun(sessionId, response) as Promise<Answer | Suspended>;
}
`;
}

/**
 * Fill in the two entry points.
 *
 * A replacement rather than a template literal in the emitter: the source being
 * substituted into is itself TypeScript, and nesting one template inside another
 * makes every `${` in the emitted file something to escape.
 */
function fill(template: string, request: GenerateRequest): string {
  return template
    .replaceAll(CAPABILITY, request.flow.id)
    .replaceAll(PACKAGE, request.packageName)
    .replaceAll(DESCRIPTION, quote(request.description));
}

/** The README: what the capability is, and how each of the three surfaces calls it. */
function docs(request: GenerateRequest): string {
  const { flow } = request;
  const fields = Object.entries(flow.input).map(
    ([name, field]) => `| \`${name}\` | ${field.kind} | ${field.description ?? ''} |`,
  );

  const answers = [...flow.outcomes.map((outcome) => outcome.id)];

  const interactions = Object.values(interactionsOf(flow));

  return `# ${request.packageName}

${request.description}

Generated by Interfacer from a recorded run against \`${request.variant.recordedAgainst}\` on
\`${request.variant.recordedOn}\`. The source is the artifact: read \`src/flow.ts\` to see exactly
what this does, step by step.

## input

| field | kind | |
| --- | --- | --- |
${fields.join('\n')}

${
  Object.values(flow.input).some((field) => field.kind === 'secret')
    ? 'Secrets are never accepted on the command line and never appear in the MCP tool schema. They are read from the environment, in SCREAMING_SNAKE_CASE, or from the keyboard.\n'
    : ''
}
## answers

Success and every declared business outcome come back as members of one union,
discriminated by \`status\`. Only a hard failure is thrown.

${answers.length === 0 ? '- success only' : answers.map((id) => `- \`${id}\``).join('\n')}

## effects

| dimension | declared |
| --- | --- |
| mutates | \`${flow.effects.mutates}\` |
| reversible | \`${flow.effects.reversible}\` |
| securityEffect | \`${flow.effects.securityEffect}\` |
| scope | \`${flow.effects.scope}\` |
| external | \`${flow.effects.external}\` |
| financial | \`${flow.effects.financial}\` |
| idempotent | \`${String(flow.effects.idempotent)}\` |
| dataClasses | ${flow.effects.dataClasses.map((one) => `\`${one}\``).join(', ')} |

${
  requiresApproval(flow.effects)
    ? 'This capability requires a human approval before its point of no return, and is refused a run that cannot obtain one.\n'
    : ''
}${
    interactions.length === 0
      ? 'It runs unattended: it declares no interactions.\n'
      : 'It is **attended**: it stops to ask a human.\n\n' +
        interactions.map((one) => `- \`${one.name}\` (${one.kind}) — ${one.prompt}`).join('\n') +
        '\n'
  }
## the three surfaces

\`\`\`sh
npx ${request.packageName} --help          # the command line
\`\`\`

\`\`\`ts
import { ${flow.id} } from '${request.packageName}';

const result = await ${flow.id}(input, { resolver });
switch (result.status) {
  // every arm the union declares
}
\`\`\`

Registered as an MCP server, it exposes one tool named \`${flow.id}\`, with its
input schema read from the field declarations and its output schema from the
answers above.
`;
}

const PARSERS: Readonly<Record<string, string>> = {
  ts: 'typescript',
  json: 'json',
  md: 'markdown',
};

/**
 * Emitted source is formatted before it is written.
 *
 * The artifact is meant to be read and diffed by a human and by a model, and a
 * printer that also has to decide where lines break would be a second, worse
 * formatter. Interfacer is a developer tool, so it can depend on a real one; the
 * generated project inherits nothing from it.
 */
async function formatted(path: string, contents: string): Promise<string> {
  const parser = PARSERS[path.slice(path.lastIndexOf('.') + 1)];
  return parser === undefined ? contents : format(contents, { parser, singleQuote: true });
}

export async function generateProject(request: GenerateRequest): Promise<ProjectFiles> {
  refuseImpossible(request);

  const emitted: readonly (readonly [string, string])[] = [
    ['package.json', packageJson(request)],
    ['tsconfig.json', TSCONFIG],
    ['src/contract.ts', contract(request)],
    ['src/flow.ts', flowModule(request)],
    ['src/variant.ts', variantModule(request)],
    ['src/index.ts', indexModule(request)],
    ['src/cli.ts', fill(CLI_TEMPLATE, request)],
    ['src/mcp.ts', fill(MCP_TEMPLATE, request)],
    ['README.md', docs(request)],
  ];

  const files = new Map<string, string>();
  for (const [path, contents] of emitted) {
    files.set(path, await formatted(path, contents));
  }

  // Copied verbatim: it is already built output, and running it through a
  // formatter would rewrite code nobody in this project wrote.
  for (const [path, contents] of await vendoredDsl()) {
    files.set(path, contents);
  }

  return files;
}
