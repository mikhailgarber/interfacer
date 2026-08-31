import { describe, expect, it } from 'vitest';

import {
  boolean,
  fieldNames,
  fields,
  number,
  secret,
  secretFieldNames,
  text,
} from '@interfacer/dsl';

/**
 * These are the runtime half of the contract. The type half is in
 * `fields.test-d.ts` — together they are the claim that one declaration serves
 * the compiler, the MCP schema, the CLI parser and the docs.
 */

const inputFields = fields({
  url: text({ description: 'entry point' }),
  username: text(),
  password: secret(),
  accountRef: text({ description: 'account to look up' }),
});

// @covers contract.one-declaration-many-readers
describe('fields', () => {
  it('keeps the declaration readable at run time', () => {
    // The reason the declaration is a value at all: an interface is erased and
    // leaves nothing for the MCP server, the CLI parser or the docs to read.
    expect(inputFields.url).toEqual({ kind: 'text', description: 'entry point' });
    expect(inputFields.password).toEqual({ kind: 'secret' });
  });

  it('omits an absent description rather than storing undefined', () => {
    // A published MCP schema should not carry `"description": undefined`.
    expect(Object.hasOwn(inputFields.username, 'description')).toBe(false);
  });

  it('preserves declaration order', () => {
    // The order a CLI help text and a generated doc list flags in.
    expect(fieldNames(inputFields)).toEqual(['url', 'username', 'password', 'accountRef']);
  });

  it('freezes the declaration and each field', () => {
    expect(Object.isFrozen(inputFields)).toBe(true);
    expect(Object.isFrozen(inputFields.password)).toBe(true);
  });

  it('rejects an empty field name', () => {
    expect(() => fields({ '': text() })).toThrow(TypeError);
  });

  it('carries the non-string kinds the interview can produce', () => {
    const declaration = fields({
      amount: number({ description: 'in minor units' }),
      dryRun: boolean(),
    });

    expect(declaration.amount.kind).toBe('number');
    expect(declaration.dryRun.kind).toBe('boolean');
  });
});

// @covers contract.secret-is-a-runtime-marker
describe('secretFieldNames', () => {
  it('names the fields the CLI must refuse on argv and the record must redact', () => {
    // Read from the declaration, not from supplied values, so a field declared
    // secret is treated as one even when nothing was passed for it.
    expect(secretFieldNames(inputFields)).toEqual(['password']);
  });

  it('is empty when nothing is secret', () => {
    expect(secretFieldNames(fields({ url: text() }))).toEqual([]);
  });

  it('finds every secret, not just the first', () => {
    const declaration = fields({
      username: text(),
      password: secret(),
      apiToken: secret({ description: 'service token' }),
    });

    expect(secretFieldNames(declaration)).toEqual(['password', 'apiToken']);
  });
});
