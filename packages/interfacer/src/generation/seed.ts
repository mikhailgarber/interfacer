/**
 * Recovering a sibling's flow from the project that holds it.
 *
 * Seeded discovery is the project-update path with a seed copied in: a project
 * from another tenant is verified rather than trusted, and verifying it means
 * performing its steps against the new application. That needs the steps as the
 * engine understands them, and the project holds them as TypeScript.
 *
 * So this reads them back — the inverse of the printer, and deliberately paired
 * with it. What it recovers it recovers by **calling the builder**: a parsed
 * `.fillForm(...)` becomes a real `flow.fillForm(...)`, so a step here is
 * constructed by the same code that constructs one during discovery and there
 * is no second idea of what a step is.
 *
 * Two things are deliberately not carried across.
 *
 * The outcome declarations, because wording is precisely what differs between
 * tenants and a detector carried across unverified is the failure this whole
 * mechanism exists to prevent. The seed arrives with its steps and no
 * detectors, so every declared outcome goes through provocation exactly as it
 * would on a first run — there is nothing to forget to re-check.
 *
 * And anything this cannot parse. A flow is a sequence, so a step it cannot
 * read makes every step after it unmoored; reading stops there and discovery
 * carries on from that point. A hand-edited project therefore costs re-
 * discovery of the part that was edited, never a silently wrong flow.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  answer,
  asMoney,
  asNumber,
  asText,
  byLabel,
  byRole,
  byText,
  css,
  extracted,
  field,
  join as joined,
  literal,
  obtained,
  type Described,
  type FieldSet,
  type Flow,
  type Target,
  type TargetChain,
} from '@interfacer/dsl';

import { balanced, stringAt, unescape } from '../source.js';
import type { Contract } from '../interview/contract.js';
import { flowFor } from './flow.js';

export interface Seed {
  /** The steps that were recovered, on a flow carrying this run's contract. */
  readonly flow: Flow<FieldSet, unknown>;
  /** How many calls were read before one could not be. */
  readonly read: number;
  /** The call reading stopped at, where it did. Discovery resumes from there. */
  readonly stoppedAt?: string;
}

/**
 * An accessor with its input type erased.
 *
 * The seed's flow is built at run time from a contract, so its input type is
 * not known in this file — and a function taking `never` is assignable wherever
 * an accessor is expected, which confines the erasure to this one alias instead
 * of putting a cast at every call site. The same alias the agent's tools use,
 * for the same reason.
 */
type AnyAccessor = ((...args: readonly unknown[]) => never) & Described;

const PARSES: Readonly<Record<string, (of: string) => unknown>> = {
  asText,
  asNumber,
  asMoney,
};

/**
 * Read a sibling project's flow onto a flow carrying this run's contract.
 *
 * Returns nothing where there is nothing to read: no project, no flow module,
 * or a module whose builder call this cannot find. Discovery then starts from
 * an empty flow, which is the honest fallback — it is what a first run does.
 */
export function readSeed(dir: string, contract: Contract): Seed | undefined {
  let source: string;
  try {
    source = readFileSync(join(dir, 'src', 'flow.ts'), 'utf8');
  } catch {
    return undefined;
  }

  const anchor = source.indexOf('new Flow(');
  if (anchor === -1) {
    return undefined;
  }

  const opener = source.indexOf('{', anchor);
  const optionsEnd = closes(source, opener);
  const flow = flowFor(contract);
  let read = 0;

  for (const call of calls(source, optionsEnd)) {
    try {
      if (!apply(flow, call)) {
        return { flow, read, stoppedAt: call.method };
      }
      read += 1;
    } catch {
      // A call the builder itself refused — a duplicate id, an accessor naming
      // an input this contract no longer declares. The flow it would have made
      // is not one this run can stand on.
      return { flow, read, stoppedAt: call.method };
    }
  }

  return { flow, read };
}

interface Call {
  readonly method: string;
  readonly args: readonly string[];
}

/** The chained calls after the builder's options, in order. */
function calls(source: string, from: number): readonly Call[] {
  const found: Call[] = [];
  const chain = /\.([A-Za-z_$][\w$]*)\s*\(/g;
  chain.lastIndex = from;

  for (let match = chain.exec(source); match !== null; match = chain.exec(source)) {
    const { inner } = balanced(source, chain.lastIndex - 1);
    found.push({ method: match[1] ?? '', args: split(inner) });
    chain.lastIndex = closes(source, chain.lastIndex - 1) + 1;
  }

  return found;
}

/** Where the literal opened at `from` closes. */
function closes(source: string, from: number): number {
  const { inner } = balanced(source, from);
  return from + inner.length + 1;
}

/** Top-level arguments, which is where a nested comma must not split. */
function split(inner: string): readonly string[] {
  const parts: string[] = [];
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
    } else if (char === ',' && depth === 0) {
      parts.push(inner.slice(start, at).trim());
      start = at + 1;
    }
  }

  const last = inner.slice(start).trim();
  if (last !== '') {
    parts.push(last);
  }
  return parts;
}

/** A single-quoted or double-quoted string, as its value. */
function text(source: string | undefined): string | undefined {
  const match = /^(['"])((?:\\.|(?!\1).)*)\1$/.exec((source ?? '').trim());
  return match?.[2] === undefined ? undefined : unescape(match[2]);
}

/** `['a', 'b']`, or a single string, as the accessible names a target admits. */
function names(source: string): string | readonly string[] | undefined {
  const one = text(source);
  if (one !== undefined) {
    return one;
  }
  const listed = source.trim();
  if (!listed.startsWith('[')) {
    return undefined;
  }
  const parts = split(balanced(listed, 0).inner).map(text);
  return parts.some((part) => part === undefined) ? undefined : (parts as readonly string[]);
}

function target(source: string): Target | undefined {
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(source.trim());
  if (call === null) {
    return undefined;
  }
  const args = split(balanced(source.trim(), source.trim().indexOf('(')).inner);

  switch (call[1]) {
    case 'byRole': {
      const role = text(args[0]);
      if (role === undefined) {
        return undefined;
      }
      const name = args[1] === undefined ? undefined : names(args[1]);
      return name === undefined ? byRole(role) : byRole(role, name);
    }
    case 'byLabel': {
      const label = args[0] === undefined ? undefined : names(args[0]);
      return label === undefined ? undefined : byLabel(label);
    }
    case 'byText': {
      const shown = text(args[0]);
      return shown === undefined ? undefined : byText(shown);
    }
    case 'css': {
      const selector = text(args[0]);
      return selector === undefined ? undefined : css(selector);
    }
    default:
      return undefined;
  }
}

function chainOf(source: string): TargetChain | undefined {
  const listed = source.trim();
  if (!listed.startsWith('[')) {
    return undefined;
  }
  const targets = split(balanced(listed, 0).inner).map(target);
  if (targets.length === 0 || targets.some((one) => one === undefined)) {
    return undefined;
  }
  return targets.filter((one): one is Target => one !== undefined) as unknown as TargetChain;
}

/**
 * A described accessor, read back as the same call that printed it.
 *
 * Only the described forms exist here, which is the point of them: a closure
 * cannot be printed back into source, so the printer refuses one — and nothing
 * this reads was written any other way.
 */
function accessor(source: string): AnyAccessor | undefined {
  const trimmed = source.trim();
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
  if (call === null) {
    return undefined;
  }
  const args = split(balanced(trimmed, trimmed.indexOf('(')).inner);

  switch (call[1]) {
    case 'field': {
      const name = text(args[0]);
      return name === undefined
        ? undefined
        : (field<Record<string, unknown>, string>(name) as unknown as AnyAccessor);
    }
    case 'obtained': {
      const name = text(args[0]);
      return name === undefined
        ? undefined
        : (obtained<Record<string, unknown>, string>(name) as unknown as AnyAccessor);
    }
    case 'extracted': {
      const name = text(args[0]);
      return name === undefined
        ? undefined
        : (extracted<Record<string, unknown>, string>(name) as unknown as AnyAccessor);
    }
    case 'literal': {
      const value = text(args[0]);
      return value === undefined ? undefined : (literal(value) as unknown as AnyAccessor);
    }
    case 'answer': {
      // The success map and an outcome's map are the same shape: a status, and
      // the values reported with it, each read from somewhere rather than
      // stated. Anything it cannot read makes the whole call unreadable.
      const status = text(args[0]);
      if (status === undefined) {
        return undefined;
      }
      const values: Record<string, AnyAccessor> = {};
      for (const [key, source] of pairs(args[1])) {
        const read = accessor(source);
        if (read === undefined) {
          return undefined;
        }
        values[key] = read;
      }
      return answer(status, values) as unknown as AnyAccessor;
    }

    case 'join': {
      const parts = args.map(accessor);
      return parts.some((part) => part === undefined)
        ? undefined
        : (joined(...parts.map((part) => part as never)) as unknown as AnyAccessor);
    }
    default:
      return undefined;
  }
}

/** The `key: value` pairs of an object literal, unparsed on the value side. */
function pairs(source: string | undefined): readonly (readonly [string, string])[] {
  if (source?.trim().startsWith('{') !== true) {
    return [];
  }

  const found: (readonly [string, string])[] = [];
  for (const entry of split(balanced(source.trim(), 0).inner)) {
    const colon = entry.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = entry.slice(0, colon).trim();
    found.push([text(key) ?? key, entry.slice(colon + 1).trim()]);
  }
  return found;
}

/** The `{ id: '…' }` a step carries, so the record goes on naming it the same. */
function options(source: string | undefined): Record<string, unknown> {
  if (source?.trim().startsWith('{') !== true) {
    return {};
  }
  const inner = balanced(source.trim(), 0).inner;
  const id = stringAt(inner, 'id');
  const prompt = stringAt(inner, 'prompt');
  const within = stringAt(inner, 'within');
  return {
    ...(id === undefined ? {} : { id }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(within === undefined ? {} : { within }),
  };
}

/**
 * Replay one call onto the builder.
 *
 * `false` means it could not be read — not that it was invalid. The caller
 * stops there rather than skipping it, because a flow is a sequence.
 */
function apply(flow: Flow<FieldSet, unknown>, call: Call): boolean {
  const [first, second, third] = call.args;

  switch (call.method) {
    case 'open': {
      const url = accessor(first ?? '');
      if (url === undefined) {
        return false;
      }
      flow.open(url, options(second));
      return true;
    }

    case 'fillForm':
    case 'choose': {
      const chain = chainOf(first ?? '');
      const value = accessor(second ?? '');
      if (chain === undefined || value === undefined) {
        return false;
      }
      flow[call.method](chain, value, options(third));
      return true;
    }

    case 'pressButton':
    case 'commit':
    case 'checkpoint': {
      const chain = chainOf(first ?? '');
      if (chain === undefined) {
        return false;
      }
      flow[call.method](chain, options(second));
      return true;
    }

    case 'extract': {
      const name = text(first);
      const chain = chainOf(second ?? '');
      const parse = PARSES[(third ?? '').trim()];
      if (name === undefined || chain === undefined || parse === undefined) {
        return false;
      }
      flow.extract(name, chain, parse, options(call.args[3]));
      return true;
    }

    case 'pauseUntil': {
      const chain = chainOf(first ?? '');
      if (chain === undefined) {
        return false;
      }
      flow.pauseUntil(chain, options(second));
      return true;
    }

    case 'pauseForInput': {
      const name = text(first);
      if (name === undefined) {
        return false;
      }
      const declared = options(second);
      flow.pauseForInput(name, {
        prompt: typeof declared.prompt === 'string' ? declared.prompt : name,
        ...declared,
      });
      return true;
    }

    case 'pauseForApproval':
    case 'pauseForOperator': {
      const prompt = text(first);
      if (prompt === undefined) {
        return false;
      }
      flow[call.method](prompt, options(second));
      return true;
    }

    case 'returns': {
      const map = accessor(first ?? '');
      if (map === undefined) {
        return false;
      }
      flow.returns(map);
      return true;
    }

    case 'outcome':
      // Deliberately dropped rather than read. Wording is what differs between
      // tenants, so a detector is re-provoked against the new application or it
      // is not carried at all.
      return true;

    default:
      return false;
  }
}
