import {
  answer,
  asMoney,
  asNumber,
  asText,
  byLabel,
  css,
  describes,
  extracted,
  field,
  fields,
  Flow,
  join,
  literal,
  makeSecret,
  obtained,
  secret,
  text,
  type Secret,
} from '@interfacer/dsl';
import { describe, expect, it } from 'vitest';

/**
 * Accessors that carry what they read.
 *
 * They exist so a flow can be printed back into source, which means each one has
 * to be right twice: it must read the value the engine expects, and it must
 * describe itself as the thing the generator will print. A test that checked
 * only the descriptor would pass on an accessor that reads the wrong field.
 */

const inputFields = fields({
  url: text(),
  accountRef: text(),
  password: secret(),
});

const input = {
  url: 'https://example.invalid',
  accountRef: 'ACC-1001',
  password: makeSecret('s3cret'),
};

const got: Record<string, Secret> = { mfaCode: makeSecret('123456') };

// @covers dsl.accessors-carry-their-source
describe('reading a value', () => {
  it('takes a declared input field by name', () => {
    const read = field<typeof input, 'accountRef'>('accountRef');

    expect(read(input)).toBe('ACC-1001');
    expect(read.source).toEqual({ from: 'input', name: 'accountRef' });
  });

  it('takes a secret without revealing it', () => {
    const read = field<typeof input, 'password'>('password');

    // The `Secret` travels as a `Secret`. Only a DSL primitive reveals one, and
    // an accessor is not a primitive.
    expect(String(read(input))).toBe('[redacted]');
    expect(read(input).reveal()).toBe('s3cret');
  });

  it('takes what a pause obtained', () => {
    const read = obtained<typeof got, 'mfaCode'>('mfaCode');

    expect(read(input, got).reveal()).toBe('123456');
    expect(read.source).toEqual({ from: 'obtained', name: 'mfaCode' });
  });

  it('takes what a step extracted', () => {
    const read = extracted<{ balance: number }, 'balance'>('balance');

    expect(read({ balance: 12.5 })).toBe(12.5);
    expect(read.source).toEqual({ from: 'extracted', name: 'balance' });
  });

  it('takes a stated value', () => {
    const read = literal<'TELLER'>('TELLER');

    expect(read()).toBe('TELLER');
    expect(read.source).toEqual({ from: 'literal', value: 'TELLER' });
  });
});

describe('joining an entry point to a path', () => {
  it('concatenates the parts and describes both', () => {
    const url = join<typeof input>(
      field<typeof input, 'url'>('url'),
      literal<'/transfer'>('/transfer'),
    );

    expect(url(input, {})).toBe('https://example.invalid/transfer');
    expect(url.source).toEqual({
      from: 'join',
      parts: [
        { from: 'input', name: 'url' },
        { from: 'literal', value: '/transfer' },
      ],
    });
  });

  it('refuses a secret rather than building one into a URL', () => {
    // A credential in a URL reaches the address bar, the referrer and the run
    // record's navigation entry, and none of those redact it.
    const url = join<typeof input>(field<typeof input, 'password'>('password'));

    expect(() => url(input, {})).toThrow(/refuses a secret/);
  });
});

describe('parsing what a step read off the page', () => {
  it('offers the three parses a capability needs', () => {
    expect(asText('ACC-1001')).toBe('ACC-1001');
    expect(asNumber('42')).toBe(42);
    expect(asMoney('£1,234.56')).toBe(1234.56);
    expect(asMoney('-$40.00')).toBe(-40);
  });

  it('describes which parse it is, so the generator prints the name', () => {
    expect(asText.source).toEqual({ from: 'parse', as: 'text' });
    expect(asMoney.source).toEqual({ from: 'parse', as: 'money' });
  });
});

describe('building an answer', () => {
  /**
   * Built through the flow methods, which is the only place `answer()` is
   * meaningful: the container it reads is the one the method hands it, so the
   * types resolve from the position rather than from an annotation.
   */
  const start = () => new Flow({ id: 'checks', input: inputFields }).open(field('url'));

  it('reads extracted values for a result', () => {
    const flow = start()
      .extract('balance', [byLabel('Balance')], asMoney)
      .returns(answer('ok', { balance: extracted('balance') }));

    expect(flow.result?.({ balance: 12.5 } as never, undefined as never)).toEqual({
      status: 'ok',
      balance: 12.5,
    });
  });

  it('reads the input for an outcome', () => {
    const flow = start()
      .outcome([css('#missing')], answer('account_not_found', { accountRef: field('accountRef') }))
      .returns(answer('ok'));

    const map = flow.outcomes[0]?.map as (i: typeof input, p: object) => unknown;

    expect(map(input, got)).toEqual({ status: 'account_not_found', accountRef: 'ACC-1001' });
  });

  it('is a bare status where there is nothing to carry', () => {
    const flow = start()
      .outcome([css('#denied')], answer('permission_denied'))
      .returns(answer('ok'));

    const declared = flow.outcomes[0]?.map as ((i: unknown, p: unknown) => unknown) & {
      source: unknown;
    };

    expect(declared(input, got)).toEqual({ status: 'permission_denied' });
    expect(declared.source).toEqual({
      from: 'answer',
      status: 'permission_denied',
      values: {},
    });
  });

  it('refuses a value that cannot be printed', () => {
    // A plain closure runs perfectly well and cannot be emitted. Refusing it
    // while the flow is being built is the last moment the offending arm has a
    // name attached to it.
    expect(() =>
      start()
        .extract('balance', [byLabel('Balance')], asMoney)
        .returns(answer('ok', { balance: (values: { balance: number }) => values.balance })),
    ).toThrow(/not a described accessor/);
  });
});

describe('an answer handed the wrong container', () => {
  const start = () => new Flow({ id: 'checks', input: inputFields }).open(field('url'));

  /**
   * The compiler already refuses the common case: `extracted('ref')` in an
   * `.outcome()` is checked against the *input's* field names, so a name that
   * exists in only one container is a compile error and never reaches here.
   * What is left is a name that exists in both — an `accountRef` the flow also
   * extracts — where the map type-checks, reads the wrong object and prints the
   * wrong accessor. That is what these two cover.
   */
  const extractsAccountRef = () => start().extract('accountRef', [byLabel('Account')], asText);

  it('refuses extracted() in an outcome, where the input is what arrives', () => {
    expect(() =>
      extractsAccountRef().outcome(
        [css('#missing')],
        answer('account_not_found', { ref: extracted('accountRef') }),
      ),
    ).toThrow(/\.outcome\(\)/);
  });

  it('refuses field() in a result, where the extracted values are what arrive', () => {
    expect(() => extractsAccountRef().returns(answer('ok', { ref: field('accountRef') }))).toThrow(
      /\.returns\(\)/,
    );
  });

  it('is a guard on the descriptor, so a hand-written mapper passes through', () => {
    // The rule is about maps built here. A closure the generator will refuse is
    // still a legal flow, and nothing about it is checkable.
    expect(() =>
      start()
        .extract('balance', [byLabel('Balance')], asMoney)
        .returns(({ balance }) => ({ status: 'ok' as const, balance })),
    ).not.toThrow();
  });
});

describe('telling the two kinds of accessor apart', () => {
  it('is what the generator asks before printing', () => {
    expect(describes(field<typeof input, 'url'>('url'))).toBe(true);
    expect(describes((i: typeof input) => i.url)).toBe(false);
  });
});
