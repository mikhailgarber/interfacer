/**
 * `Secret<T>` — the type of a value the caller supplies for a field declared
 * with `secret()`.
 *
 * The two are halves of one mechanism and it is worth being precise about which
 * is which: `secret()` marks a *field* in the declaration, and is what the CLI
 * parser reads to refuse the flag and what the run record reads to redact.
 * `Secret<T>` is the type of the *value*.
 *
 * The point of this wrapper is that redaction is the **default** rather than a
 * logging convention someone has to remember at every call site. The value lives
 * in a closure, so it is structurally absent from the object: string
 * interpolation, `JSON.stringify` and Node's inspector all yield `[redacted]`,
 * and the value can reach the page only through an explicit `.reveal()` inside a
 * DSL primitive.
 */

declare const secretBrand: unique symbol;

/**
 * A real symbol, so `isSecret` can recognise one at run time. Registered with
 * `Symbol.for` rather than created fresh, so two copies of this package in one
 * dependency graph still agree on what a secret is.
 *
 * It is defined non-enumerably on the object, so it does not survive a spread or
 * show up in `Object.keys`.
 */
const SECRET_MARKER = Symbol.for('interfacer.secret');

/** Node's `util.inspect` hook — what `console.log` actually calls. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** What every representation of a secret renders as. */
export const REDACTED = '[redacted]';

export interface Secret<T = string> {
  readonly [secretBrand]: true;

  /** Explicit, and the only way to read the value. */
  reveal(): T;

  /** Always {@link REDACTED}. */
  toString(): string;

  /** Always {@link REDACTED}. */
  toJSON(): string;
}

/**
 * Wrap a value so that reading it takes a deliberate `.reveal()`.
 *
 * There is no way back out other than `reveal`: the value is captured in the
 * closure below and never stored as a property, so no amount of enumeration,
 * serialization or inspection reaches it.
 */
export function makeSecret<T>(value: T): Secret<T> {
  const secret = {
    reveal: (): T => value,
    toString: (): string => REDACTED,
    toJSON: (): string => REDACTED,
    [INSPECT]: (): string => REDACTED,
  };

  Object.defineProperty(secret, SECRET_MARKER, { value: true, enumerable: false });

  // The brand is a compile-time-only symbol, so no literal can satisfy the
  // interface. This is the single place that cast is made.
  return Object.freeze(secret) as unknown as Secret<T>;
}

/**
 * Whether a value is a {@link Secret}.
 *
 * The run record and the CLI parser both need this at run time, where the
 * compile-time brand is not available.
 */
export function isSecret(candidate: unknown): candidate is Secret<unknown> {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    SECRET_MARKER in candidate &&
    (candidate as Record<symbol, unknown>)[SECRET_MARKER] === true
  );
}
