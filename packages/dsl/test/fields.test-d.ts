import { expectTypeOf } from 'vitest';

import { boolean, fields, number, secret, text, type Infer, type Secret } from '@interfacer/dsl';

/**
 * The type half of the contract claim.
 *
 * `fields()` is a runtime value and `Infer` derives the type from it, so this is
 * the only place that derivation can be checked — a runtime test would pass
 * whatever the types said. Adding a field has to change the compiler's view, the
 * served tool schema and the accepted command line together; these assertions
 * are the "compiler's view" third of that.
 */

const inputFields = fields({
  url: text({ description: 'entry point' }),
  username: text(),
  password: secret(),
  accountRef: text({ description: 'account to look up' }),
});

type Input = Infer<typeof inputFields>;

// @covers contract.input-type-inferred position.contract-in-types
// The shape the design's worked example specifies, exactly.
expectTypeOf<Input>().toEqualTypeOf<{
  url: string;
  username: string;
  password: Secret<string>;
  accountRef: string;
}>();

// A secret field's value type is `Secret<string>`, never a bare string — which
// is what makes reaching the value take a deliberate `.reveal()`.
expectTypeOf<Input['password']>().not.toEqualTypeOf<string>();
expectTypeOf<Input['password']['reveal']>().toEqualTypeOf<() => string>();

// The non-string kinds the interview can produce.
const typedFields = fields({
  amount: number(),
  dryRun: boolean(),
  memo: text(),
});

expectTypeOf<Infer<typeof typedFields>>().toEqualTypeOf<{
  amount: number;
  dryRun: boolean;
  memo: string;
}>();

// `fields()` anchors inference: the declaration's literal shape survives, so
// `Infer` sees four named fields rather than a widened index signature.
expectTypeOf<keyof Input>().toEqualTypeOf<'url' | 'username' | 'password' | 'accountRef'>();

// An input object is complete or it does not type-check. There are no optional
// inputs in the contract, so a caller cannot omit one and discover it at replay.
expectTypeOf<Input>().not.toEqualTypeOf<Partial<Input>>();
