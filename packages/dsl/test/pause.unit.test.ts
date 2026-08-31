import {
  checkResponse,
  fields,
  Flow,
  interactionsOf,
  isAttended,
  isSuspended,
  makeSecret,
  parseDuration,
  secret,
  text,
  byRole,
} from '@interfacer/dsl';
import { describe, expect, it } from 'vitest';

/**
 * The pure half of pause and resume: bounds, response validation, and what a
 * flow publishes about the pauses it declares.
 *
 * No browser and no engine. What is here is exhaustively testable because it is
 * pure, which is the same reason `decideVerification` was factored out — the
 * rules that decide whether a run continues should not be reachable only through
 * a live page.
 */

const input = fields({ url: text(), password: secret() });

describe('parseDuration', () => {
  // @covers pause.every-pause-bounded
  it('reads the units the design writes bounds in', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1.5s')).toBe(1_500);
    expect(parseDuration(' 30s ')).toBe(30_000);
  });

  it('takes a plain number as milliseconds, which is what the engine works in', () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(750)).toBe(750);
  });

  it('throws on a bound it cannot read, rather than picking one', () => {
    // A default here would be an unbounded pause wearing a number, or a bound
    // nobody chose. Both are worse than failing while the flow is being built.
    expect(() => parseDuration('30 seconds')).toThrow(/invalid duration/);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
    expect(() => parseDuration('')).toThrow(/invalid duration/);
    expect(() => parseDuration(-1)).toThrow(/invalid duration/);
    expect(() => parseDuration(Number.NaN)).toThrow(/invalid duration/);
  });

  // @covers pause.every-pause-bounded
  it('rejects a bad bound while the flow is being built, not mid-run', () => {
    expect(() =>
      new Flow({ id: 'bad', input }).pauseUntil([byRole('heading', 'x')], { within: 'later' }),
    ).toThrow(/invalid duration/);
  });
});

// @covers pause.response-validated-against-kind
describe('checkResponse', () => {
  // @covers pause.four-kinds
  it('admits exactly the answer each kind asked for', () => {
    expect(checkResponse('input', makeSecret('123456')).ok).toBe(true);
    expect(checkResponse('approval', true).ok).toBe(true);
    expect(checkResponse('approval', false).ok).toBe(true);
    expect(checkResponse('operator', 'done').ok).toBe(true);
  });

  it('refuses an answer of the wrong kind rather than coercing it', () => {
    // One resolver serves every kind, so the response type cannot be tied to the
    // request kind at compile time. Guessing which way a caller meant a
    // mis-typed answer is exactly the guess that must not be made about an
    // authorization.
    const mismatches = [
      checkResponse('approval', makeSecret('yes')),
      checkResponse('approval', 'done'),
      checkResponse('input', true),
      checkResponse('input', 'done'),
      checkResponse('operator', true),
      checkResponse('operator', makeSecret('done')),
    ];

    expect(mismatches.map((check) => check.ok)).toEqual([false, false, false, false, false, false]);
  });

  it('says what it wanted and what it got, so the failure is legible', () => {
    const check = checkResponse('approval', makeSecret('yes'));
    expect(check).toEqual({ ok: false, expected: 'a boolean', observed: 'a Secret' });
  });

  it('never reveals the secret it was handed', () => {
    const check = checkResponse('approval', makeSecret('hunter2'));
    expect(JSON.stringify(check)).not.toContain('hunter2');
  });
});

describe('isSuspended', () => {
  it('recognises the control state and nothing else', () => {
    expect(
      isSuspended({
        status: 'suspended',
        sessionId: 's1',
        request: { kind: 'input', name: 'n', prompt: 'p', secret: true, expiresAt: 'now' },
      }),
    ).toBe(true);
    expect(isSuspended({ status: 'ok', balance: 1 })).toBe(false);
    expect(isSuspended(null)).toBe(false);
    expect(isSuspended('suspended')).toBe(false);
  });
});

describe('the interactions a flow publishes', () => {
  // @covers project.attended-iff-interactions
  it('is empty for a flow that never stops to ask', () => {
    const flow = new Flow({ id: 'quiet', input }).open((i) => i.url);

    expect(interactionsOf(flow)).toEqual({});
    expect(isAttended(flow)).toBe(false);
  });

  // @covers pause.declared-is-not-an-escalation project.attended-iff-interactions
  it('names every declared pause, so a caller knows before invoking', () => {
    const flow = new Flow({ id: 'asks', input })
      .pauseForInput('mfaCode', { prompt: 'Enter the 6-digit code' })
      .pauseForApproval('Send it?', { id: 'send.approve' })
      .pauseForOperator('Clear the dialog', { id: 'dialog.handover' });

    expect(interactionsOf(flow)).toEqual({
      mfaCode: {
        kind: 'input',
        name: 'mfaCode',
        prompt: 'Enter the 6-digit code',
        // Every value obtained mid-run is a secret: it has never been through
        // the field declarations, so nothing else would redact it.
        secret: true,
      },
      'send.approve': {
        kind: 'approval',
        name: 'send.approve',
        prompt: 'Send it?',
        secret: false,
      },
      'dialog.handover': {
        kind: 'operator',
        name: 'dialog.handover',
        prompt: 'Clear the dialog',
        secret: false,
      },
    });
    expect(isAttended(flow)).toBe(true);
  });

  // @covers pause.four-kinds project.attended-iff-interactions
  it('does not count a surface wait, because polling asks nobody', () => {
    // `pauseUntil` is resolved by polling, so it raises no request and cannot
    // make a capability attended. Counting it would mean any flow that waits for
    // a page to load would announce that it needs a human.
    const flow = new Flow({ id: 'waits', input }).pauseUntil([byRole('heading', 'Summary')], {
      within: '10s',
    });

    expect(interactionsOf(flow)).toEqual({});
    expect(isAttended(flow)).toBe(false);
  });

  it('refuses two pauses asking for the same name', () => {
    // The second would silently replace the first in both the published
    // interactions and the values later accessors read.
    expect(() =>
      new Flow({ id: 'clash', input })
        .pauseForInput('code', { prompt: 'first' })
        .pauseForInput('code', { prompt: 'second' }),
    ).toThrow(/duplicate obtained value "code"/);
  });
});
