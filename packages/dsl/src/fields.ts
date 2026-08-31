/**
 * Contract declarations: the capability's inputs, declared once as a runtime
 * value with the TypeScript type inferred from it.
 *
 * A TypeScript `interface` is erased at compile time and leaves nothing behind
 * to read, but three consumers need the field list at run time — the MCP server,
 * which must publish an input schema; the CLI parser, which must know the flags
 * and which of them to refuse on argv; and the generated documentation.
 * Declaring the type and then hand-writing a schema for them would reintroduce
 * exactly the second representation the artifact-as-program design exists to
 * avoid.
 *
 * So the declaration is the value, and the type is derived:
 *
 * ```ts
 * export const inputFields = fields({
 *   url:        text({ description: 'entry point' }),
 *   username:   text(),
 *   password:   secret(),
 *   accountRef: text({ description: 'account to look up' }),
 * });
 *
 * export type Input = Infer<typeof inputFields>;
 * // { url: string; username: string; password: Secret<string>; accountRef: string }
 * ```
 *
 * Adding a field changes the compiler's view, the served tool schema and the
 * accepted command line together, because there is only one of them to change.
 */
import type { Secret } from './secret.js';

export type FieldKind = 'text' | 'number' | 'boolean' | 'secret';

export interface Field<K extends FieldKind = FieldKind> {
  readonly kind: K;
  /**
   * Not decoration: this becomes the field description in the generated MCP
   * schema, which is what a calling agent reads to decide what to pass.
   */
  readonly description?: string;
}

export interface FieldOptions {
  readonly description?: string;
}

/** A declaration of a capability's inputs. */
export type FieldSet = Readonly<Record<string, Field>>;

function makeField<K extends FieldKind>(kind: K, options: FieldOptions): Field<K> {
  return Object.freeze(
    options.description === undefined ? { kind } : { kind, description: options.description },
  );
}

export function text(options: FieldOptions = {}): Field<'text'> {
  return makeField('text', options);
}

export function number(options: FieldOptions = {}): Field<'number'> {
  return makeField('number', options);
}

export function boolean(options: FieldOptions = {}): Field<'boolean'> {
  return makeField('boolean', options);
}

/**
 * A credential, token, or anything else that must never be persisted or logged.
 *
 * This has to be a runtime marker rather than a type. The rule that a secret is
 * never accepted on argv is enforced by the CLI parser, which is ordinary code
 * and cannot see a type — `password: Secret<string>` in an erased interface is
 * unenforceable. As a value, `secret()` is what the parser reads to refuse the
 * flag and what the run record reads to redact.
 */
export function secret(options: FieldOptions = {}): Field<'secret'> {
  return makeField('secret', options);
}

/**
 * Declare a capability's inputs.
 *
 * Identity at run time apart from freezing; its job is to anchor inference so
 * that `Infer<typeof …>` sees the literal shape rather than a widened one.
 */
export function fields<const F extends FieldSet>(declaration: F): F {
  for (const [name, field] of Object.entries(declaration)) {
    if (name.length === 0) {
      throw new TypeError('a field name cannot be empty');
    }
    Object.freeze(field);
  }
  return Object.freeze(declaration);
}

/** The type of the value a caller supplies for one field. */
export type ValueOf<F extends Field> =
  F extends Field<'text'>
    ? string
    : F extends Field<'number'>
      ? number
      : F extends Field<'boolean'>
        ? boolean
        : F extends Field<'secret'>
          ? // `Secret` defaults to `Secret<string>`: a secret reaches the process
            // as a string, from the environment or from stdin, never from argv.
            Secret
          : never;

/**
 * The input object type a {@link FieldSet} describes.
 *
 * `-readonly` is deliberate. The declaration is frozen and its inferred type is
 * readonly throughout, but an `Input` is an ordinary object a caller builds and
 * passes in — inheriting the declaration's immutability would make the contract
 * harder to satisfy without protecting anything.
 */
export type Infer<F extends FieldSet> = {
  -readonly [K in keyof F]: ValueOf<F[K]>;
};

/** Every declared field name, in declaration order. */
export function fieldNames(declaration: FieldSet): string[] {
  return Object.keys(declaration);
}

/**
 * The names the CLI parser must refuse on argv and the run record must redact.
 *
 * Read from the declaration rather than from the supplied values, so a field
 * that is declared secret is treated as one even when nothing was passed for it.
 */
export function secretFieldNames(declaration: FieldSet): string[] {
  return Object.entries(declaration)
    .filter(([, field]) => field.kind === 'secret')
    .map(([name]) => name);
}
