import { expectTypeOf } from 'vitest';

import {
  css,
  fields,
  Flow,
  makeSecret,
  runFlow,
  secret,
  text,
  type InteractionRequest,
  type InteractionResponse,
  type Resolver,
  type Suspended,
} from '@interfacer/dsl';

/**
 * The master-function contract, checked by the compiler.
 *
 * `suspended` is a control state, not a business outcome, and it is precisely
 * what a caller gets when no resolver is available. The overloads make that
 * visible in the type: a caller that supplies a resolver never handles the arm
 * at all, because with somewhere to ask the engine asks and loops internally.
 *
 * This is a type-level test because the claim *is* a claim about types. A
 * runtime test could show that a run with a resolver happens not to suspend; only
 * the compiler can show that such a caller is never asked to handle it.
 */

const inputFields = fields({ url: text(), password: secret() });

const flow = new Flow({ id: 'capability', input: inputFields })
  .open((i) => i.url)
  .fillForm([css('#password')], (i) => i.password)
  .pauseForApproval('Go ahead?')
  .returns(() => ({ status: 'ok' as const }));

const input = { url: 'https://example.invalid', password: makeSecret('pw') };

const resolver: Resolver = () => Promise.resolve(true);

// @covers project.resolver-removes-the-suspended-arm
// A resolver is supplied: the engine asks and loops internally, never suspending.
expectTypeOf(runFlow(flow, input, { resolver })).toEqualTypeOf<Promise<{ status: 'ok' }>>();

// No resolver: nowhere to ask, so the run parks and the caller must say what it
// does about that.
expectTypeOf(runFlow(flow, input)).toEqualTypeOf<Promise<{ status: 'ok' } | Suspended>>();
expectTypeOf(runFlow(flow, input, { headless: false })).toEqualTypeOf<
  Promise<{ status: 'ok' } | Suspended>
>();

// The failure mode: if the overloads were collapsed into one signature, the
// resolver-supplied call would carry an arm its caller can never receive.
expectTypeOf(runFlow(flow, input, { resolver })).not.toEqualTypeOf<
  Promise<{ status: 'ok' } | Suspended>
>();

// One resolver serves every kind. The cost is that the response type is not tied
// to the request kind — which is why the engine validates it at run time.
expectTypeOf<Resolver>().toEqualTypeOf<
  (request: InteractionRequest) => Promise<InteractionResponse>
>();
expectTypeOf<Suspended>().toEqualTypeOf<{
  readonly status: 'suspended';
  readonly sessionId: string;
  readonly request: InteractionRequest;
}>();
