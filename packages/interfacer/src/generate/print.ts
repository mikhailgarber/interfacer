/**
 * Printing a flow back into source.
 *
 * The artifact is a program, so generation ends in TypeScript a human reviews
 * and diffs — not a manifest, not a step file, nothing serialized out of the
 * flow object. This module is where that happens, and it is the reason the
 * accessors carry what they read: a closure cannot be printed back into source,
 * and one that could would still be wrong, since anything it captured is not in
 * the emitted file.
 *
 * Two rules shape everything below. Every step prints its **explicit id**, so
 * the emitted flow refers to `login.submit` exactly as the run that discovered
 * it did — a derived id is a convenience for a flow written by hand, never for
 * one that was recorded. And anything unprintable is **refused by name** rather
 * than approximated: a generator that guessed would emit a project that compiles
 * and does the wrong thing, which is worse than one that does not exist.
 */
import type {
  ActionStep,
  Effects,
  Field,
  FieldSet,
  Flow,
  OutcomeDeclaration,
  Step,
  Target,
  TargetChain,
  ValueSource,
} from '@interfacer/dsl';
import { describes } from '@interfacer/dsl';

/**
 * A flow that cannot be emitted, named at the step that cannot be.
 *
 * Its own class because the fix is particular: the flow runs, and what is
 * missing is the descriptor that says what an accessor reads.
 */
export class UnprintableFlow extends Error {
  readonly step: string;

  constructor(step: string, detail: string) {
    super(`${step}: ${detail}`);
    this.name = new.target.name;
    this.step = step;
  }
}

/** Single-quoted, because that is what the emitted project is written in. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/**
 * A bound, printed the way the design writes one.
 *
 * The engine keeps milliseconds; `'30s'` is what a reviewer reads. Exact
 * multiples only — 90 seconds prints as `'90s'` rather than `'1.5m'`, because a
 * fraction in a duration reads as a mistake.
 */
export function printDuration(ms: number): string {
  if (ms % 60_000 === 0 && ms !== 0) {
    return quote(`${String(ms / 60_000)}m`);
  }
  if (ms % 1_000 === 0 && ms !== 0) {
    return quote(`${String(ms / 1_000)}s`);
  }
  return quote(`${String(ms)}ms`);
}

/**
 * Everything the emitted module imports from the DSL, gathered as it prints.
 *
 * Values and types are kept apart because the emitted project compiles under
 * `verbatimModuleSyntax`, where a type imported as a value is an error. The
 * import statement is therefore built from what was actually printed rather than
 * from a fixed list — a fixed one would import names a given flow does not use.
 */
export class Imports {
  readonly #values = new Set<string>();
  readonly #types = new Set<string>();

  use<T extends string>(name: T): T {
    this.#values.add(name);
    return name;
  }

  useType<T extends string>(name: T): T {
    this.#types.add(name);
    return name;
  }

  /** The import statements the module needs, in the order a reader expects. */
  statements(module: string): string {
    const lines: string[] = [];
    if (this.#values.size > 0) {
      lines.push(`import { ${sorted(this.#values).join(', ')} } from ${quote(module)};`);
    }
    if (this.#types.size > 0) {
      lines.push(`import type { ${sorted(this.#types).join(', ')} } from ${quote(module)};`);
    }
    return lines.join('\n');
  }
}

function sorted(names: ReadonlySet<string>): readonly string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function printName(name: string | readonly string[]): string {
  return typeof name === 'string' ? quote(name) : `[${name.map((one) => quote(one)).join(', ')}]`;
}

export function printTarget(target: Target, imports: Imports): string {
  switch (target.by) {
    case 'role':
      return target.name === undefined
        ? `${imports.use('byRole')}(${quote(target.role)})`
        : `${imports.use('byRole')}(${quote(target.role)}, ${printName(target.name)})`;
    case 'label':
      return `${imports.use('byLabel')}(${printName(target.text)})`;
    case 'text':
      return `${imports.use('byText')}(${quote(target.text)})`;
    case 'css':
      return `${imports.use('css')}(${quote(target.selector)})`;
  }
}

/** A chain prints best-first, exactly as it was recorded. */
export function printChain(chain: TargetChain, imports: Imports): string {
  return `[${chain.map((target) => printTarget(target, imports)).join(', ')}]`;
}

export function printValueSource(source: ValueSource, imports: Imports): string {
  switch (source.from) {
    case 'input':
      return `${imports.use('field')}(${quote(source.name)})`;
    case 'obtained':
      return `${imports.use('obtained')}(${quote(source.name)})`;
    case 'extracted':
      return `${imports.use('extracted')}(${quote(source.name)})`;
    case 'literal':
      return `${imports.use('literal')}(${
        typeof source.value === 'string' ? quote(source.value) : String(source.value)
      })`;
    case 'join':
      return `${imports.use('join')}(${source.parts
        .map((part) => printValueSource(part, imports))
        .join(', ')})`;
    case 'parse':
      return imports.use(
        source.as === 'text' ? 'asText' : source.as === 'number' ? 'asNumber' : 'asMoney',
      );
    case 'answer': {
      const entries = Object.entries(source.values);
      if (entries.length === 0) {
        return `${imports.use('answer')}(${quote(source.status)})`;
      }
      const values = entries
        .map(([key, value]) => `${key}: ${printValueSource(value, imports)}`)
        .join(', ');
      return `${imports.use('answer')}(${quote(source.status)}, { ${values} })`;
    }
  }
}

/** The descriptor an accessor carries, or a refusal naming the step. */
function sourceOf(accessor: unknown, step: string, what: string): ValueSource {
  if (typeof accessor !== 'function' || !describes(accessor)) {
    throw new UnprintableFlow(
      step,
      `${what} is a plain closure, which cannot be printed back into source — build it with field(), obtained(), extracted(), literal(), join() or answer()`,
    );
  }
  return accessor.source;
}

function printOptions(entries: readonly (readonly [string, string])[]): string {
  return `{ ${entries.map(([key, value]) => `${key}: ${value}`).join(', ')} }`;
}

function printActionStep(step: ActionStep, imports: Imports, indent: string): string {
  const options = printOptions([['id', quote(step.id)]]);

  switch (step.kind) {
    case 'fillForm':
      return `${indent}.fillForm(${printChain(step.target, imports)}, ${printValueSource(
        sourceOf(step.value, step.id, 'the value'),
        imports,
      )}, ${options})`;
    case 'pressButton':
      return `${indent}.pressButton(${printChain(step.target, imports)}, ${options})`;
    case 'choose':
      return `${indent}.choose(${printChain(step.target, imports)}, ${printValueSource(
        sourceOf(step.value, step.id, 'the value'),
        imports,
      )}, ${options})`;
  }
}

/** A branch's steps, printed as statements on the branch rather than as a chain. */
function printBranch(steps: readonly ActionStep[], imports: Imports, indent: string): string {
  return steps
    .map((step) => `${indent}branch${printActionStep(step, imports, '').trimStart()};`)
    .join('\n');
}

export function printStep(step: Step, imports: Imports): string {
  const id = printOptions([['id', quote(step.id)]]);

  switch (step.kind) {
    case 'open':
      return `  .open(${printValueSource(sourceOf(step.url, step.id, 'the URL'), imports)}, ${id})`;

    case 'fillForm':
    case 'pressButton':
    case 'choose':
      return printActionStep(step, imports, '  ');

    case 'commit':
      return `  .commit(${printChain(step.target, imports)}, ${id})`;

    case 'checkpoint':
      return `  .checkpoint(${printChain(step.target, imports)}, ${id})`;

    case 'extract':
      return `  .extract(${quote(step.name)}, ${printChain(step.target, imports)}, ${printValueSource(
        sourceOf(step.parse, step.id, 'the parse'),
        imports,
      )}, ${id})`;

    case 'pauseUntil':
      return `  .pauseUntil(${printChain(step.target, imports)}, ${printOptions([
        ['within', printDuration(step.withinMs)],
        ['id', quote(step.id)],
      ])})`;

    case 'pause':
      switch (step.pauseKind) {
        case 'input':
          return `  .pauseForInput(${quote(step.name)}, ${printOptions([
            ['prompt', quote(step.prompt)],
            ['within', printDuration(step.withinMs)],
            ['id', quote(step.id)],
          ])})`;
        case 'approval':
          return `  .pauseForApproval(${quote(step.prompt)}, ${printOptions([
            ['within', printDuration(step.withinMs)],
            ['id', quote(step.id)],
          ])})`;
        case 'operator':
          return `  .pauseForOperator(${quote(step.prompt)}, ${printOptions([
            ['within', printDuration(step.withinMs)],
            ['id', quote(step.id)],
          ])})`;
      }
      break;

    case 'optional':
      return [
        `  .optional(`,
        `    ${printChain(step.target, imports)},`,
        `    (branch) => {`,
        printBranch(step.steps, imports, '      '),
        `    },`,
        `    ${id},`,
        `  )`,
      ].join('\n');

    case 'oneOf':
      return [
        `  .oneOf(`,
        `    [`,
        ...step.arms.map((arm) =>
          [
            `      {`,
            `        when: ${printChain(arm.when, imports)},`,
            `        then: (branch) => {`,
            printBranch(arm.steps, imports, '          '),
            `        },`,
            `      },`,
          ].join('\n'),
        ),
        `    ],`,
        `    ${id},`,
        `  )`,
      ].join('\n');
  }

  // Unreachable while the vocabulary is closed, and the point of saying so is
  // that adding a verb without teaching the printer must not emit a flow that
  // silently drops a step.
  throw new UnprintableFlow(
    (step as Step).id,
    `no printer for step kind ${JSON.stringify((step as Step).kind)}`,
  );
}

function printOutcome(outcome: OutcomeDeclaration, imports: Imports): string {
  return `  .outcome(${printChain(outcome.detector, imports)}, ${printValueSource(
    sourceOf(outcome.map, outcome.id, 'the outcome map'),
    imports,
  )}, ${printOptions([['id', quote(outcome.id)]])})`;
}

/** A field declaration, printed as the call that made it. */
function printField(field: Field, imports: Imports): string {
  const factory = imports.use(field.kind === 'secret' ? 'secret' : field.kind);
  return field.description === undefined
    ? `${factory}()`
    : `${factory}(${printOptions([['description', quote(field.description)]])})`;
}

export function printFields(declaration: FieldSet, imports: Imports): string {
  const lines = Object.entries(declaration).map(
    ([name, field]) => `  ${name}: ${printField(field, imports)},`,
  );
  return `${imports.use('fields')}({\n${lines.join('\n')}\n})`;
}

/** `effects` as the literal a caller and an MCP description both read. */
export function printEffects(effects: Effects): string {
  const classes = effects.dataClasses.map((one) => quote(one)).join(', ');
  return [
    '{',
    `  mutates: ${quote(effects.mutates)},`,
    `  reversible: ${quote(effects.reversible)},`,
    `  securityEffect: ${quote(effects.securityEffect)},`,
    `  scope: ${quote(effects.scope)},`,
    `  external: ${quote(effects.external)},`,
    `  financial: ${quote(effects.financial)},`,
    `  idempotent: ${String(effects.idempotent)},`,
    `  dataClasses: [${classes}],`,
    '} as const',
  ].join('\n');
}

/**
 * The flow itself: the one file generation genuinely synthesizes.
 *
 * Everything else a project contains is either a declaration copied out of the
 * contract or the same entry point every capability gets. This is the part that
 * differs, and it is deliberately the part a reviewer reads top to bottom.
 */
export function printFlow(flow: Flow<FieldSet, unknown>, imports: Imports): string {
  // `input` and `effects` are printed as shorthand: the contract module exports
  // them under exactly those names, and `effects: effects` reads as a mistake.
  const options: (readonly [string, string])[] = [
    ['id', quote(flow.id)],
    ['input', 'inputFields'],
    ['effects', ''],
  ];

  if (flow.declaredAllowlist.length > 0) {
    options.push([
      'allowlist',
      `[${flow.declaredAllowlist.map((pattern) => quote(pattern)).join(', ')}]`,
    ]);
  }

  const head = [
    `export const flow = new ${imports.use('Flow')}({`,
    ...options.map(([key, value]) => (value === '' ? `  ${key},` : `  ${key}: ${value},`)),
    '})',
  ].join('\n');

  const steps = flow.steps.map((step) => printStep(step, imports));
  const outcomes = flow.outcomes.map((outcome) => printOutcome(outcome, imports));

  // A flow with no `.returns()` is a run that stopped before it reached the
  // goal — the budget ran out, or the stall guard fired. It is still written:
  // a re-run reads the project like any other and continues from here rather
  // than starting over, which only works if what was discovered is on disk.
  if (flow.result === undefined) {
    return [
      '// PARTIAL. Discovery stopped before it reached the goal, so this flow',
      '// declares no .returns() and cannot answer yet. Re-run Interfacer here',
      '// to continue from these steps.',
      head,
      ...steps,
      ...outcomes,
      '  ;',
    ].join('\n');
  }

  const result = `  .returns(${printValueSource(
    sourceOf(flow.result, flow.id, 'the result map'),
    imports,
  )});`;

  return [head, ...steps, ...outcomes, result].join('\n');
}
