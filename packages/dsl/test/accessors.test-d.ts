import {
  answer,
  asMoney,
  byLabel,
  css,
  extracted,
  field,
  fields,
  Flow,
  join,
  literal,
  makeSecret,
  obtained,
  runFlow,
  secret,
  text,
  type Secret,
} from '@interfacer/dsl';
import { expectTypeOf } from 'vitest';

/**
 * Described accessors carry what they read *and* keep the compiler's checks.
 *
 * The point of the factories is that nothing is given up for printability: a
 * name the input does not declare is still an error, a `Secret` still cannot
 * reach a verb that takes a string, and the answer union is still inferred from
 * the flow rather than written down beside it. A descriptor bought at the price
 * of `any` would be a worse trade than printing closures.
 */

const inputFields = fields({
  url: text({ description: 'entry point' }),
  accountRef: text(),
  password: secret(),
});

const flow = new Flow({ id: 'checkAccountBalance', input: inputFields })
  .open(join(field('url'), literal('/accounts')))
  .fillForm([css('#password')], field('password'))
  .pauseForInput('mfaCode', { prompt: 'code?' })
  .fillForm([css('#mfa')], obtained('mfaCode'))
  .extract('balance', [byLabel('Balance')], asMoney)
  .outcome([css('#missing')], answer('account_not_found', { accountRef: field('accountRef') }))
  .outcome([css('#denied')], answer('permission_denied', { requiredRole: literal('TELLER') }))
  .returns(answer('ok', { balance: extracted('balance') }));

const input = {
  url: 'https://example.invalid',
  accountRef: 'ACC-1001',
  password: makeSecret('pw'),
};

// The union is inferred through the factories, arm by arm, exactly as it is
// through hand-written mappers.
expectTypeOf(runFlow(flow, input, { resolver: () => Promise.resolve(true) })).toEqualTypeOf<
  Promise<
    | { status: 'ok'; balance: number }
    | { status: 'account_not_found'; accountRef: string }
    | { status: 'permission_denied'; requiredRole: 'TELLER' }
  >
>();

// A field the input does not declare is a compile error, not a run-time surprise.
// @ts-expect-error 'nope' is not a declared input field
field<typeof input, never>('nope');

// A secret cannot reach a verb that takes a plain string: `.choose()` selects an
// option, and an option value is not somewhere a credential belongs.
const chooser = new Flow({ id: 'chooses', input: inputFields });
// @ts-expect-error Secret is not assignable to string
chooser.choose([css('#s')], field('password'));

// `.open()` takes a string, so the same rule holds for a joined URL.
expectTypeOf(
  join<{ url: string }, object>(field('url'), literal('/x')),
).returns.toEqualTypeOf<string>();

// What `obtained()` reads is always a `Secret`: it never passed through a field
// declaration, so nothing else would redact it.
expectTypeOf(obtained<{ mfaCode: Secret }, 'mfaCode'>('mfaCode')).returns.toEqualTypeOf<Secret>();
