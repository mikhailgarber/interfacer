/**
 * Reading a project's own declarations back as the answers it was built from.
 *
 * On a rerun the interview is a delta rather than a repeat, and the recorded
 * answers are the project itself — `fields()`, `effects`, `interactions`, the
 * allowlist and the outcomes the flow declares. Reading the code rather than a
 * sidecar file is what keeps a hand-edited project honest: an edit to the flow
 * is visible to the next interview immediately, instead of being contradicted by
 * a stale record of what was once asked for.
 *
 * The source rather than the build, for the same reason. A project is an
 * ordinary repository between runs — committed, edited, refactored — and a hand
 * edit nobody has compiled yet is exactly the case the delta exists to catch.
 *
 * Everything here fails toward asking. A declaration this cannot parse is
 * absent, an absent answer is a gap, and a gap is a question — so the worst a
 * tolerant reader does is ask about something already settled. Guessing in the
 * other direction would carry an answer nobody gave into a generated project.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  DataClass,
  External,
  FieldKind,
  Financial,
  HostPattern,
  Mutates,
  Reversible,
  Scope,
  SecurityEffect,
} from '@interfacer/dsl';

import type {
  ContractDraft,
  EffectsDraft,
  InputAnswer,
  InteractionAnswer,
  OutcomeAnswer,
} from './contract.js';

/** The three modules a generated project keeps its declarations in. */
const CONTRACT = join('src', 'contract.ts');
const FLOW = join('src', 'flow.ts');
const INDEX = join('src', 'index.ts');

function read(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The end of the literal that starts at `from`, skipping string contents.
 *
 * Strings have to be skipped rather than ignored: a target chain contains
 * `css('input[name="username"]')`, whose brackets and quotes would close a
 * literal that is nowhere near finished.
 */
function balanced(source: string, from: number): { readonly inner: string } {
  let depth = 0;
  let quote: string | undefined;

  for (let at = from; at < source.length; at += 1) {
    const char = source[at];

    if (quote !== undefined) {
      if (char === '\\') {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
    } else if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
      if (depth === 0) {
        return { inner: source.slice(from + 1, at) };
      }
    }
  }

  return { inner: '' };
}

/** The literal following an anchor — `export const effects = {…}` and friends. */
function region(source: string | undefined, anchor: string, opener: string): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  const at = source.indexOf(anchor);
  if (at === -1) {
    return undefined;
  }
  const start = source.indexOf(opener, at + anchor.length);
  return start === -1 ? undefined : balanced(source, start).inner;
}

function unescape(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

function stringAt(source: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(source);
  return match?.[2] === undefined ? undefined : unescape(match[2]);
}

function booleanAt(source: string, key: string): boolean | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*(true|false)\\b`).exec(source);
  return match === null ? undefined : match[1] === 'true';
}

function stringsAt(source: string, key: string): readonly string[] | undefined {
  const at = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(source);
  if (at === null) {
    return undefined;
  }
  const { inner } = balanced(source, at.index + at[0].length - 1);
  return [...inner.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((match) =>
    unescape(match[2] ?? ''),
  );
}

const FIELD_KINDS: readonly FieldKind[] = ['text', 'number', 'boolean', 'secret'];

function inputsOf(source: string | undefined): readonly InputAnswer[] | undefined {
  const declared = region(source, 'export const inputFields', '{');
  if (declared === undefined) {
    return undefined;
  }

  const inputs: InputAnswer[] = [];
  const entry = /([A-Za-z_$][\w$]*)\s*:\s*(text|number|boolean|secret)\s*\(/g;

  for (let match = entry.exec(declared); match !== null; match = entry.exec(declared)) {
    const kind = match[2] as FieldKind;
    if (!FIELD_KINDS.includes(kind)) {
      continue;
    }
    const { inner } = balanced(declared, entry.lastIndex - 1);
    const description = stringAt(inner, 'description');
    inputs.push({
      name: match[1] ?? '',
      kind,
      ...(description === undefined ? {} : { description }),
    });
  }

  return inputs.length === 0 ? undefined : inputs;
}

function effectsOf(source: string | undefined): EffectsDraft | undefined {
  const declared = region(source, 'export const effects', '{');
  if (declared === undefined) {
    return undefined;
  }

  // Omitted rather than carried as `undefined`: an absent declaration is a
  // question the interview asks, and `exactOptionalPropertyTypes` makes the
  // difference one the compiler keeps.
  const dataClasses = stringsAt(declared, 'dataClasses') as readonly DataClass[] | undefined;
  const mutates = stringAt(declared, 'mutates') as Mutates | undefined;
  const reversible = stringAt(declared, 'reversible') as Reversible | undefined;
  const securityEffect = stringAt(declared, 'securityEffect') as SecurityEffect | undefined;
  const scope = stringAt(declared, 'scope') as Scope | undefined;
  const external = stringAt(declared, 'external') as External | undefined;
  const financial = stringAt(declared, 'financial') as Financial | undefined;
  const idempotent = booleanAt(declared, 'idempotent');

  return {
    ...(mutates === undefined ? {} : { mutates }),
    ...(reversible === undefined ? {} : { reversible }),
    ...(securityEffect === undefined ? {} : { securityEffect }),
    ...(scope === undefined ? {} : { scope }),
    ...(external === undefined ? {} : { external }),
    ...(financial === undefined ? {} : { financial }),
    ...(idempotent === undefined ? {} : { idempotent }),
    ...(dataClasses === undefined ? {} : { dataClasses }),
  };
}

function outcomesOf(source: string | undefined): readonly OutcomeAnswer[] | undefined {
  if (source === undefined) {
    return undefined;
  }

  const outcomes: OutcomeAnswer[] = [];
  const call = /\.outcome\s*\(/g;

  for (let match = call.exec(source); match !== null; match = call.exec(source)) {
    const { inner } = balanced(source, call.lastIndex - 1);
    // The status the answer carries, not the step id: the status is the arm of
    // the result union, which is what the interview declared.
    const status = /\banswer\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(inner);
    if (status?.[2] !== undefined) {
      outcomes.push({ id: unescape(status[2]) });
    }
  }

  // A flow that declares none is a real answer — but only where a flow was read
  // at all, which the caller decides by whether the module was there.
  return outcomes;
}

function outputOf(source: string | undefined): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  const at = source.lastIndexOf('.returns(');
  if (at === -1) {
    return undefined;
  }

  const { inner } = balanced(source, source.indexOf('(', at));
  const status = /\banswer\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(inner);
  if (status?.[2] === undefined) {
    return undefined;
  }

  const values = inner.indexOf('{');
  const keys = values === -1 ? [] : topLevelKeys(balanced(inner, values).inner);
  return keys.length === 0
    ? `status ${unescape(status[2])}`
    : `status ${unescape(status[2])} with ${keys.join(', ')}`;
}

/** The keys of an object literal, ignoring anything nested inside its values. */
function topLevelKeys(inner: string): readonly string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;

  for (let at = 0; at < inner.length; at += 1) {
    const char = inner[at];

    if (quote !== undefined) {
      if (char === '\\') {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{' || char === '[' || char === '(') {
      depth += 1;
    } else if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
    } else if (char === ':' && depth === 0) {
      const key = /([A-Za-z_$][\w$]*)\s*$/.exec(inner.slice(start, at));
      if (key?.[1] !== undefined) {
        keys.push(key[1]);
      }
    } else if (char === ',' && depth === 0) {
      start = at + 1;
    }
  }

  return keys;
}

function interactionsOf(source: string | undefined): readonly InteractionAnswer[] | undefined {
  const declared = region(source, 'export const interactions', '{');
  if (declared === undefined) {
    return undefined;
  }

  const interactions: InteractionAnswer[] = [];
  const entry = /(?:([A-Za-z_$][\w$]*)|['"]([^'"]+)['"])\s*:\s*\{/g;

  for (let match = entry.exec(declared); match !== null; match = entry.exec(declared)) {
    const { inner } = balanced(declared, entry.lastIndex - 1);
    const kind = stringAt(inner, 'kind');
    const name = stringAt(inner, 'name') ?? match[1] ?? match[2];
    const prompt = stringAt(inner, 'prompt');
    if (kind === undefined || name === undefined || prompt === undefined) {
      continue;
    }
    interactions.push({
      kind: kind as InteractionAnswer['kind'],
      name,
      prompt,
      secret: booleanAt(inner, 'secret') ?? false,
    });
  }

  return interactions;
}

/**
 * Everything a generated project already answers.
 *
 * The entry point and the task are deliberately not among them. Neither is a
 * declaration: the entry point is an input supplied per call, and the task is
 * what this run is being asked for — which is why a delta against another tenant
 * usually comes down to the entry point alone.
 */
export function recordedAnswers(dir: string): ContractDraft {
  const contract = read(dir, CONTRACT);
  const flow = read(dir, FLOW);
  const index = read(dir, INDEX);

  const options = region(flow, 'new Flow(', '{');
  const capability = options === undefined ? undefined : stringAt(options, 'id');
  const allowlist =
    options === undefined ? undefined : (stringsAt(options, 'allowlist') as HostPattern[]);
  const effects = effectsOf(contract);

  const authority: ContractDraft['authority'] = {
    // Read back from a project a human accepted and committed: the confirmed
    // list is stored explicitly in the project precisely so a rerun costs a
    // confirmation rather than a second pass through every question.
    ...(allowlist === undefined ? {} : { allowlist: 'project' as const }),
    ...(effects?.securityEffect === undefined ? {} : { securityEffect: 'project' as const }),
  };

  const inputs = inputsOf(contract);
  const output = outputOf(flow);
  const outcomes = outcomesOf(flow);
  const interactions = interactionsOf(index);

  return {
    ...(capability === undefined ? {} : { capability }),
    ...(inputs === undefined ? {} : { inputs }),
    ...(output === undefined ? {} : { output }),
    ...(outcomes === undefined ? {} : { outcomes }),
    ...(interactions === undefined ? {} : { interactions }),
    ...(effects === undefined ? {} : { effects }),
    ...(allowlist === undefined ? {} : { allowlist }),
    authority,
  };
}
