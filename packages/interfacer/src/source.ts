/**
 * Reading a generated project's own source.
 *
 * Two readers need the same scanning: the delta interview, which recovers the
 * declarations a project already answers, and seeded discovery, which recovers
 * the steps a sibling recorded. Both read the **source** rather than a build,
 * because a project is an ordinary repository between runs and a hand edit
 * nobody has compiled yet is exactly what they exist to see.
 *
 * Everything here fails toward absence. What cannot be parsed is not there, and
 * what is not there gets asked about or discovered again — which is the safe
 * direction: the unsafe one carries an answer nobody gave into a project.
 */
/**
 * The end of the literal that starts at `from`, skipping string contents.
 *
 * Strings have to be skipped rather than ignored: a target chain contains
 * `css('input[name="username"]')`, whose brackets and quotes would close a
 * literal that is nowhere near finished.
 */
export function balanced(source: string, from: number): { readonly inner: string } {
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
export function region(
  source: string | undefined,
  anchor: string,
  opener: string,
): string | undefined {
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

export function unescape(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

export function stringAt(source: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(source);
  return match?.[2] === undefined ? undefined : unescape(match[2]);
}

export function booleanAt(source: string, key: string): boolean | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*(true|false)\\b`).exec(source);
  return match === null ? undefined : match[1] === 'true';
}

export function stringsAt(source: string, key: string): readonly string[] | undefined {
  const at = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(source);
  if (at === null) {
    return undefined;
  }
  const { inner } = balanced(source, at.index + at[0].length - 1);
  return [...inner.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((match) =>
    unescape(match[2] ?? ''),
  );
}

/** The keys of an object literal, ignoring anything nested inside its values. */
export function topLevelKeys(inner: string): readonly string[] {
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
