import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FieldSet, Flow } from '@interfacer/dsl';
import { generateProject, readSeed, writeProject, type Contract } from 'interfacer';
import { describe, expect, it } from 'vitest';

import { attendedCapability, balanceCapability, variant } from './capability.js';

/**
 * Reading a project's flow back out of its own source.
 *
 * The reader is the printer's pair, so it is asserted against the printer:
 * emit a capability, read it back, and compare what the builder made both
 * times. A verb the printer can write and the reader cannot read would
 * otherwise show up as a seeded run quietly re-discovering something it already
 * had.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'interfacer-seed-'));
}

/** The contract a rerun would carry: the same inputs the project declares. */
function contract(): Contract {
  return {
    capability: 'checkAccountBalance',
    task: 'read the balance of an account',
    entryPoint: 'https://mybank.invalid/',
    inputs: [
      { name: 'url', kind: 'text' },
      { name: 'username', kind: 'text' },
      { name: 'password', kind: 'secret' },
      { name: 'accountRef', kind: 'text' },
    ],
    output: 'a balance',
    outcomes: [],
    interactions: [],
    effects: {
      mutates: 'read',
      reversible: 'yes',
      securityEffect: 'none',
      scope: 'single',
      external: 'none',
      financial: 'none',
      idempotent: true,
      dataClasses: ['non-identifying'],
    },
    allowlist: ['mybank.invalid'],
    authority: { allowlist: 'human', securityEffect: 'human' },
  };
}

async function emitted(flow: Flow<FieldSet, unknown>): Promise<string> {
  const root = scratch();
  const files = await generateProject({
    flow,
    packageName: 'mybank-balance',
    description: 'Read a checking account balance.',
    variant,
  });
  await writeProject(files, root);
  return root;
}

describe('a project read back as a seed', () => {
  it('recovers every step the printer wrote, with its id', async () => {
    const original = balanceCapability();
    const seed = readSeed(await emitted(original), contract());

    expect(seed?.stoppedAt).toBeUndefined();
    expect(seed?.flow.steps.map((step) => [step.kind, step.id])).toEqual(
      original.steps.map((step) => [step.kind, step.id]),
    );
  });

  it('recovers pauses, joined values and literals too', async () => {
    // The other half of the vocabulary: a pause with a bound, an entry point
    // built from two pieces, and a value stated outright rather than read.
    const original = attendedCapability();
    const seed = readSeed(await emitted(original), contract());

    expect(seed?.stoppedAt).toBeUndefined();
    expect(seed?.flow.steps.map((step) => [step.kind, step.id])).toEqual(
      original.steps.map((step) => [step.kind, step.id]),
    );
  });

  it('drops the outcome detectors rather than carrying them across', async () => {
    const seed = readSeed(await emitted(balanceCapability()), contract());

    // Wording is precisely what differs between tenants, so a detector is
    // provoked again against the new application or it is not carried at all.
    expect(balanceCapability().outcomes.length).toBeGreaterThan(0);
    expect(seed?.flow.outcomes).toEqual([]);
    // The success map is not a detector, and survives.
    expect(seed?.flow.result).toBeDefined();
  });

  it('stops at the first call it cannot read, and keeps what came before', () => {
    const root = scratch();
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'flow.ts'),
      [
        "export const flow = new Flow({ id: 'checkAccountBalance', input: inputFields, effects })",
        "  .open(field('url'), { id: 'login.open' })",
        "  .fillForm([byLabel('Username')], field('username'), { id: 'login.username' })",
        // Hand-edited into something the vocabulary does not have. A flow is a
        // sequence, so everything after it is unmoored too.
        '  .fillForm([byLabel(currentLabel())], whateverTheUserTyped, { id: "x" })',
        "  .pressButton([byRole('button', 'Sign in')], { id: 'login.submit' });",
      ].join('\n'),
    );

    const seed = readSeed(root, contract());

    expect(seed?.read).toBe(2);
    expect(seed?.stoppedAt).toBe('fillForm');
    expect(seed?.flow.steps.map((step) => step.id)).toEqual(['login.open', 'login.username']);
  });

  it('is nothing at all where there is no project to read', () => {
    expect(readSeed(scratch(), contract())).toBeUndefined();
  });
});
