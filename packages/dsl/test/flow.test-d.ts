import { expectTypeOf } from 'vitest';

import {
  byRole,
  byText,
  css,
  fields,
  Flow,
  secret,
  text,
  type AnswerOf,
  type InputOf,
} from '@interfacer/dsl';

/**
 * The result union is a **consequence of the steps**, not a declaration beside
 * them.
 *
 * Each `.outcome()` and the final `.returns()` widens the flow's answer type as
 * it is chained, so adding an outcome adds the arm, the MCP output schema, and
 * the caller's obligation to handle it — in one edit. Declaring the union
 * separately would be the same duplication in a second place: a hand-written arm
 * with no detector is unreachable, a detector with no arm does not type-check,
 * and nothing would catch either.
 *
 * These assertions are load-bearing beyond documentation. `A` appears in no
 * member of `Flow`, so it is a phantom parameter: `Flow<I, X, E>` and
 * `Flow<I, Y, E>` are structurally identical and mutually assignable, and the
 * compiler will happily accept `.outcome()` being "simplified" to return `this`.
 * `eslint --fix` did precisely that once, silently reducing every answer union to
 * whatever the last call added. This file is what fails when that happens.
 */

const inputFields = fields({
  url: text(),
  username: text(),
  password: secret(),
  accountRef: text(),
});

const flow = new Flow({ id: 'checkAccountBalance', input: inputFields })
  .open((i) => i.url)
  .fillForm([css('#username')], (i) => i.username)
  .fillForm([css('#password')], (i) => i.password)
  .pressButton([byRole('button', 'Sign in')])
  .outcome([byText('No such account')], (i) => ({
    status: 'account_not_found' as const,
    accountRef: i.accountRef,
  }))
  .outcome([byText('Not authorized')], () => ({
    status: 'permission_denied' as const,
    requiredRole: 'TELLER',
  }))
  .extract('balance', [css('#balance-value')], Number)
  .returns(({ balance }) => ({ status: 'ok' as const, balance }));

// @covers contract.answer-union-inferred
// Every arm the flow can produce, and nothing else. The design's worked example.
expectTypeOf<AnswerOf<typeof flow>>().toEqualTypeOf<
  | { status: 'account_not_found'; accountRef: string }
  | { status: 'permission_denied'; requiredRole: string }
  | { status: 'ok'; balance: number }
>();

// The failure mode this file exists for: if widening is lost, the union collapses
// to the success arm alone.
expectTypeOf<AnswerOf<typeof flow>>().not.toEqualTypeOf<{ status: 'ok'; balance: number }>();

// An outcome cannot be dropped silently either.
expectTypeOf<Extract<AnswerOf<typeof flow>, { status: 'account_not_found' }>>().toEqualTypeOf<{
  status: 'account_not_found';
  accountRef: string;
}>();

// `.returns()` sees what `.extract()` read, with the type the parser produced.
const parsed = new Flow({ id: 'typed', input: inputFields })
  .extract('balance', [css('#b')], Number)
  .extract('reference', [css('#r')], String)
  .returns((values) => values);

expectTypeOf<AnswerOf<typeof parsed>>().toEqualTypeOf<{ balance: number; reference: string }>();

// A flow with no outcomes has a union of exactly one arm — no accidental `never`,
// and no accidental widening either.
const happyPathOnly = new Flow({ id: 'simple', input: inputFields })
  .open((i) => i.url)
  .returns(() => ({ status: 'ok' as const }));

expectTypeOf<AnswerOf<typeof happyPathOnly>>().toEqualTypeOf<{ status: 'ok' }>();

// Before `.returns()`, a flow can answer nothing at all.
const unfinished = new Flow({ id: 'unfinished', input: inputFields }).open((i) => i.url);

expectTypeOf<AnswerOf<typeof unfinished>>().toEqualTypeOf<never>();

// The input a flow requires is the `fields()` declaration, read back.
expectTypeOf<InputOf<typeof flow>>().toEqualTypeOf<{
  url: string;
  username: string;
  password: import('@interfacer/dsl').Secret;
  accountRef: string;
}>();

// Accessors are typed against that input, so a flow is parameterized by
// construction and cannot close over a literal credential by accident.
new Flow({ id: 'accessors', input: inputFields }).fillForm([css('#u')], (i) => {
  expectTypeOf(i).toEqualTypeOf<InputOf<typeof flow>>();
  return i.username;
});
