import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { isSecret, makeSecret, REDACTED } from '@interfacer/dsl';

/**
 * Redaction is tested as a **property** rather than as an example: the claim is
 * that a secret cannot reach output, not that one particular call site formats
 * it nicely. So each test asks "does the sentinel appear anywhere in this
 * rendering", which is the same shape the Phase 3 integration test uses against
 * the whole run record.
 */

const SENTINEL = 'hunter2-Sentinel-Do-Not-Log';

// @covers secrets.redaction-is-the-default contract.secret-is-a-runtime-marker
describe('Secret', () => {
  it('reveals the value, but only when asked explicitly', () => {
    expect(makeSecret(SENTINEL).reveal()).toBe(SENTINEL);
  });

  it('carries a non-string payload just as well', () => {
    const token = makeSecret({ token: SENTINEL, expiresAt: 1 });

    expect(token.reveal()).toEqual({ token: SENTINEL, expiresAt: 1 });
    expect(`${token}`).not.toContain(SENTINEL);
  });

  describe('renders as [redacted]', () => {
    const secretValue = makeSecret(SENTINEL);

    const renderings: Record<string, () => string> = {
      'template interpolation': () => `${secretValue}`,
      // The point of the test: `+` coerces through toString, and must redact.
      // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
      'string concatenation': () => secretValue + '',
      'String()': () => String(secretValue),
      'toString()': () => secretValue.toString(),
      'JSON.stringify, bare': () => JSON.stringify(secretValue),
      'JSON.stringify, nested': () => JSON.stringify({ password: secretValue }),
      'JSON.stringify, in an array': () => JSON.stringify([secretValue]),
      // console.log goes through util.inspect, which ignores toString and would
      // otherwise print the object's shape.
      'util.inspect': () => inspect(secretValue),
      'util.inspect, nested deeply': () =>
        inspect({ input: { password: secretValue } }, { depth: 5 }),
    };

    it.each(Object.entries(renderings))('%s', (_name, render) => {
      const rendered = render();

      expect(rendered).not.toContain(SENTINEL);
      expect(rendered).toContain(REDACTED);
    });
  });

  describe('survives being thrown', () => {
    it('does not leak through an error message', () => {
      const error = new Error(`could not sign in with ${makeSecret(SENTINEL)}`);

      expect(error.message).not.toContain(SENTINEL);
      expect(error.message).toContain(REDACTED);
    });

    it('does not leak through an error serialized as evidence', () => {
      // A hard failure is thrown as a typed exception carrying context. If a
      // secret rode along in that context, it would land in the run record.
      const thrown = Object.assign(new Error('checkpoint failed'), {
        observed: { password: makeSecret(SENTINEL) },
      });

      const serialized = JSON.stringify({
        message: thrown.message,
        observed: thrown.observed,
      });

      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).toContain(REDACTED);
    });

    it('does not leak through a stack trace', () => {
      const captured = ((): string => {
        try {
          throw new Error(`bad credential: ${makeSecret(SENTINEL)}`);
        } catch (error) {
          return error instanceof Error ? (error.stack ?? '') : '';
        }
      })();

      expect(captured).toContain(REDACTED);
      expect(captured).not.toContain(SENTINEL);
    });
  });

  describe('is structurally absent, not filtered', () => {
    const secretValue = makeSecret(SENTINEL);

    it('exposes no enumerable property holding the value', () => {
      expect(Object.keys(secretValue)).toEqual(['reveal', 'toString', 'toJSON']);
      expect(Object.values(secretValue).map((value) => typeof value)).toEqual([
        'function',
        'function',
        'function',
      ]);
    });

    it('loses nothing to a spread, because there was nothing to lose', () => {
      // Writing a secret out takes a deliberate `.reveal()`; a spread copies the
      // accessors, not the value, so it cannot accidentally widen access.
      expect(JSON.stringify({ ...secretValue })).not.toContain(SENTINEL);
    });

    it('cannot be reopened by reassigning its renderers', () => {
      expect(Object.isFrozen(secretValue)).toBe(true);
    });

    it('keeps the value out of a deep property walk', () => {
      const walk = (value: unknown): string[] =>
        typeof value === 'object' && value !== null
          ? Object.values(value).flatMap(walk)
          : [String(value)];

      expect(walk({ input: { password: secretValue } }).join('|')).not.toContain(SENTINEL);
    });
  });

  describe('isSecret', () => {
    it('recognises a secret', () => {
      expect(isSecret(makeSecret(SENTINEL))).toBe(true);
    });

    it.each([
      ['a plain string', SENTINEL],
      ['null', null],
      ['undefined', undefined],
      ['a plain object', { reveal: () => SENTINEL }],
      // The shape alone is not enough: a look-alike that happens to render as
      // [redacted] is not a secret, and the CLI parser must not treat it as one.
      ['a look-alike', { reveal: () => SENTINEL, toString: () => REDACTED }],
    ])('rejects %s', (_name, candidate) => {
      expect(isSecret(candidate)).toBe(false);
    });
  });
});
