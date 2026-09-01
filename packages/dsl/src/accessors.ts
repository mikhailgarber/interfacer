/**
 * Accessors that carry what they read.
 *
 * The design takes values as accessors on the input — `i => i.username` — so a
 * flow is parameterized by construction. That is enough to *execute* a flow and
 * not enough to *emit* one: generation prints the source of a project from the
 * accumulated flow, and a closure cannot be printed back into source. Its text
 * is not recoverable in general, and where it is recoverable it is wrong, since
 * anything the closure captured is not in the emitted file.
 *
 * So an accessor built here is both halves at once: the same function the engine
 * calls, carrying a {@link ValueSource} describing what it reads. One object
 * serves execution and emission, which is the same reason the design gives for
 * declaring inputs as a value — a second representation of the same facts is
 * free to drift from the first.
 *
 * A plain closure remains a legal accessor and always will: it is what a
 * hand-written flow says, and it runs identically. It simply cannot be emitted,
 * and the generator refuses it by name rather than printing something that looks
 * right and is not.
 */
import type { FillValue } from './flow.js';
import { isSecret, type Secret } from './secret.js';

/**
 * Where a value comes from, in the form the generator prints.
 *
 * The three containers are the three things a running flow knows: the declared
 * `input`, what `.pauseForInput()` has `obtained`, and what `.extract()` has
 * read off the page. A literal is the fourth case and is not a container — it is
 * a value the flow states outright, which the design admits for an outcome's
 * fixed fields (`requiredRole: 'TELLER'`) rather than for what it types into a
 * page.
 */
export type ValueSource =
  | { readonly from: 'input'; readonly name: string }
  | { readonly from: 'obtained'; readonly name: string }
  | { readonly from: 'extracted'; readonly name: string }
  | { readonly from: 'literal'; readonly value: string | number | boolean }
  | { readonly from: 'join'; readonly parts: readonly ValueSource[] }
  | { readonly from: 'parse'; readonly as: 'text' | 'number' | 'money' }
  | {
      readonly from: 'answer';
      readonly status: string;
      readonly values: Readonly<Record<string, ValueSource>>;
    };

/** An accessor that can be printed as well as run. */
export interface Described {
  readonly source: ValueSource;
}

export function describes<T extends object>(value: T): value is T & Described {
  return 'source' in value;
}

/** Attach the descriptor without losing the function's call signature. */
function describe<F extends object>(fn: F, source: ValueSource): F & Described {
  return Object.assign(fn, { source: Object.freeze(source) });
}

/**
 * A declared input field, by name.
 *
 * The type parameters are inferred from the position it is used in rather than
 * written: the flow method supplies the input type, so `field('password')` in a
 * `.choose()` is a compile error where the field is a `Secret`, and a name the
 * input does not declare is a compile error anywhere.
 */
export function field<I, K extends keyof I & string>(name: K): ((input: I) => I[K]) & Described {
  return describe((input: I) => input[name], { from: 'input', name });
}

/** A value `.pauseForInput()` obtained mid-run. Always a `Secret`. */
export function obtained<P, K extends keyof P & string>(
  name: K,
): ((input: unknown, obtained: P) => P[K]) & Described {
  return describe((_input: unknown, got: P) => got[name], { from: 'obtained', name });
}

/**
 * A value `.extract()` read off the page, by name.
 *
 * Structurally the same read as {@link field} — both take the first argument by
 * name — and a different label, because the two are handed different containers:
 * `.returns()` receives what was extracted, `.outcome()` receives the input. The
 * label is what the generator prints and what the flow checks the map against,
 * so naming the wrong one is caught rather than emitted.
 */
export function extracted<E, K extends keyof E & string>(
  name: K,
): ((extracted: E) => E[K]) & Described {
  return describe((values: E) => values[name], { from: 'extracted', name });
}

export function literal<T extends string | number | boolean>(value: T): (() => T) & Described {
  return describe(() => value, { from: 'literal', value });
}

/**
 * Concatenate string parts — an entry point plus a path, typically.
 *
 * The one composite form, and deliberately the only one: `.open()` needs
 * `${i.url}/transfer` and nothing else in the vocabulary composes values at all.
 * Arithmetic, formatting and conditionals stay out, because a flow that computes
 * is a flow a reviewer has to trace rather than read.
 */
export function join<I, P = object>(
  ...parts: readonly (((input: I, obtained: P) => string | Secret) & Described)[]
): ((input: I, obtained: P) => string) & Described {
  const run = (input: I, got: P): string =>
    parts
      .map((part) => {
        const value = part(input, got);
        if (isSecret(value)) {
          // A secret joined into a URL reaches the address bar, the referrer and
          // the run record's navigation entry, none of which redact it. There is
          // no legitimate reading of this, so it fails rather than reveals.
          throw new Error('join() refuses a secret: a credential must not be built into a URL');
        }
        return value;
      })
      .join('');

  return describe(run, { from: 'join', parts: parts.map((part) => part.source) });
}

/** Text as it stands, trimmed by the engine before it arrives. */
export const asText: ((text: string) => string) & Described = describe((text: string) => text, {
  from: 'parse',
  as: 'text',
});

export const asNumber: ((text: string) => number) & Described = describe(
  (text: string) => Number(text),
  { from: 'parse', as: 'number' },
);

/**
 * An amount as a number: currency symbols, thousands separators and whitespace
 * dropped.
 *
 * Money is the parse a capability actually needs — a balance reads `£1,234.56`
 * on the page — and leaving it to each flow would put a different regular
 * expression in every generated project.
 */
export const asMoney: ((text: string) => number) & Described = describe(
  (text: string) => Number(text.replace(/[^\d.-]/g, '')),
  { from: 'parse', as: 'money' },
);

type Simplify<T> = { [K in keyof T]: T[K] };

/**
 * An answer: a status, plus the values that go with it.
 *
 * One builder for both endings, because the design treats them as one thing —
 * success and every declared business outcome are alike answers, and only a hard
 * failure is not. What differs is the container each is handed: `.returns()`
 * receives what `.extract()` read, `.outcome()` receives the input, since an
 * outcome fires on a page whose values were never extracted. Both are read by
 * name from the first argument, so the accessors are the same shape and only
 * their labels differ — {@link extracted} against one, {@link field} against the
 * other, and the flow refuses the mismatch when the map is declared.
 */
export function answer<
  S extends string,
  A,
  B,
  F extends Record<string, (first: A, second: B) => unknown>,
>(
  status: S,
  values?: F,
): ((first: A, second?: B) => Simplify<{ status: S } & { [K in keyof F]: ReturnType<F[K]> }>) &
  Described {
  const accessors: Record<string, (first: A, second: B) => unknown> = values ?? {};

  const described: Record<string, ValueSource> = {};
  for (const [key, accessor] of Object.entries(accessors)) {
    if (!describes(accessor)) {
      // Caught while the flow is being built, which is the last moment the name
      // of the offending arm is obvious.
      throw new Error(`answer(${JSON.stringify(status)}): ${key} is not a described accessor`);
    }
    described[key] = accessor.source;
  }

  // The second argument is optional in the signature and not in the body: a
  // `.returns()` map is handed one argument and an `.outcome()` map two, and a
  // function declaring two parameters is not assignable to a one-parameter
  // position.
  const run = (first: A, second?: B): Record<string, unknown> => {
    const built: Record<string, unknown> = { status };
    for (const [key, accessor] of Object.entries(accessors)) {
      built[key] = accessor(first, second as B);
    }
    return built;
  };

  return describe(run, { from: 'answer', status, values: described }) as ((
    first: A,
    second?: B,
  ) => Simplify<{ status: S } & { [K in keyof F]: ReturnType<F[K]> }>) &
    Described;
}

/**
 * Which container an answer's values are allowed to name.
 *
 * `.returns()` and `.outcome()` are handed different first arguments, so a map
 * built for one reads the wrong object in the other — and does so silently,
 * returning `undefined` for every field. The flow checks it where the map is
 * declared, because that is where the fix is.
 */
export function checkAnswerSources(
  map: unknown,
  allowed: 'input' | 'extracted',
  verb: string,
): void {
  if (typeof map !== 'function' || !describes(map)) {
    return;
  }

  const { source } = map;
  if (source.from !== 'answer') {
    return;
  }

  const wrong = allowed === 'input' ? 'extracted' : 'input';
  for (const [key, value] of Object.entries(source.values)) {
    if (value.from === wrong) {
      throw new Error(
        `${verb}: ${key} reads ${wrong}(), but ${verb} is handed the ${allowed} values — use ${allowed}()`,
      );
    }
  }
}

/** Narrowing helper for the value-bearing verbs, which admit a `Secret`. */
export type FillAccessor<I, P> = ((input: I, obtained: P) => FillValue) & Described;
