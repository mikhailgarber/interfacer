import {
  byRole,
  checkSafety,
  css,
  DEFAULT_EFFECTS,
  fields,
  Flow,
  requiresApproval,
  text,
  type Effects,
} from '@interfacer/dsl';
import { describe, expect, it } from 'vitest';

import { approvedTransferFlow, balanceFlow, transferFlow } from './flows.js';

/**
 * Which flows a declaration refuses, decided from the artifact alone.
 *
 * The rules are a pure function over the declaration and the shape of the flow
 * because that is what lets a run be refused before a browser opens: a flow that
 * cannot satisfy its own declaration is knowable from what was written down, and
 * logging in first to discover it buys nothing. The engine's own half of the
 * enforcement — that this *run* actually holds an approval — is
 * `safety.integration.test.ts`.
 */

const HEADLESS = { headless: true } as const;
const HEADED = { headless: false } as const;

function effects(overrides: Partial<Effects>): Effects {
  return { ...DEFAULT_EFFECTS, ...overrides };
}

const IRREVERSIBLE = effects({ mutates: 'write', reversible: 'no' });
const CHANGES_AUTHORITY = effects({ mutates: 'write', securityEffect: 'authority-change' });

const input = fields({ url: text() });

/** A flow whose approval sits *after* the commit, where it authorizes nothing. */
function approvalAfterCommitFlow(declared: Effects) {
  return new Flow({ id: 'approvalAfterCommit', input, effects: declared })
    .open((i) => i.url, { id: 'open' })
    .commit([byRole('button', 'Confirm')], { id: 'commit' })
    .pauseForApproval('Was that all right?', { id: 'approve' })
    .returns(() => ({ status: 'ok' as const }));
}

/** Two irreversible actions, and one human asked about them. */
function twoCommitsFlow(declared: Effects, approvals: 1 | 2) {
  const flow = new Flow({ id: 'twoCommits', input, effects: declared })
    .open((i) => i.url, { id: 'open' })
    .pauseForApproval('Send the first?', { id: 'approve.first' })
    .commit([css('#first')], { id: 'commit.first' });

  if (approvals === 2) {
    flow.pauseForApproval('Send the second?', { id: 'approve.second' });
  }

  return flow.commit([css('#second')], { id: 'commit.second' }).returns(() => ({
    status: 'ok' as const,
  }));
}

describe('which declarations demand a human', () => {
  it('is the two dimensions the design says drive an enforcement', () => {
    expect(requiresApproval(DEFAULT_EFFECTS)).toBe(false);
    expect(requiresApproval(IRREVERSIBLE)).toBe(true);
    expect(requiresApproval(CHANGES_AUTHORITY)).toBe(true);
    expect(requiresApproval(effects({ securityEffect: 'control-override' }))).toBe(true);
  });

  it('leaves the three declared-but-unenforced dimensions alone', () => {
    // Named in the design as declared and published rather than enforced, each
    // needing machinery nothing else here uses. A run refused for one of them
    // would be this module inventing policy the design did not ask for.
    expect(requiresApproval(effects({ scope: 'unbounded' }))).toBe(false);
    expect(requiresApproval(effects({ external: 'notifies-customer' }))).toBe(false);
    expect(requiresApproval(effects({ financial: 'moves-funds(500.00)' }))).toBe(false);
  });
});

// @covers effects.irreversible-requires-approval
describe('an irreversible commit', () => {
  it('is refused where no approval precedes it', () => {
    const violation = checkSafety(transferFlow(IRREVERSIBLE), HEADLESS);

    expect(violation?.rule).toBe('irreversible-requires-approval');
    // Attributed to the commit itself, so the record names the step to fix
    // rather than the flow that contains it.
    expect(violation?.step).toBe('transfer.commit');
  });

  it('is allowed where one does', () => {
    expect(checkSafety(approvedTransferFlow({ effects: IRREVERSIBLE }), HEADLESS)).toBeUndefined();
  });

  it('is refused where the approval follows it', () => {
    // Approval that follows the commit approves nothing. Order is the whole
    // content of the rule: a flow can satisfy "declares an approval" and still
    // have asked nobody before the point of no return.
    expect(checkSafety(approvalAfterCommitFlow(IRREVERSIBLE), HEADLESS)?.step).toBe('commit');
  });

  // @covers effects.approval-is-spent
  it('spends the approval, so a second commit needs a second one', () => {
    // One approval standing for every irreversible action in a run would
    // authorize things the approver was never shown.
    expect(checkSafety(twoCommitsFlow(IRREVERSIBLE, 1), HEADLESS)?.step).toBe('commit.second');
    expect(checkSafety(twoCommitsFlow(IRREVERSIBLE, 2), HEADLESS)).toBeUndefined();
  });

  it('does not constrain a flow that declares itself reversible', () => {
    // `reversible: 'yes'` is the default, and the unapproved commit is exactly
    // what phase 5 records with a null approval link. Refusing it here would
    // make every mutating capability attended.
    expect(checkSafety(transferFlow(effects({ mutates: 'write' })), HEADLESS)).toBeUndefined();
    expect(
      checkSafety(transferFlow(effects({ mutates: 'write', reversible: 'compensable' })), HEADLESS),
    ).toBeUndefined();
  });
});

// @covers effects.security-effect-forces-attended
describe('a securityEffect', () => {
  it('refuses a headless run', () => {
    // Changing who can access an account is the one thing this design will not
    // do with nobody watching, whatever else the flow declares — the approved
    // flow is refused for the same reason as the unapproved one.
    const violation = checkSafety(approvedTransferFlow({ effects: CHANGES_AUTHORITY }), HEADLESS);

    expect(violation?.rule).toBe('security-effect-requires-attended');
    expect(violation?.observed).toBe('headless');
  });

  it('forces an approval as well, headed', () => {
    expect(checkSafety(transferFlow(CHANGES_AUTHORITY), HEADED)?.rule).toBe(
      'irreversible-requires-approval',
    );
  });

  it('forces one even where the flow commits nothing', () => {
    // "Anything but none forces approval" is about the capability, not about a
    // step: a flow that changes who can access an account and never asks
    // anybody has not been authorized, whether or not it named one of its
    // presses a `.commit()`.
    const violation = checkSafety(balanceFlow({ effects: CHANGES_AUTHORITY }), HEADED);

    expect(violation?.rule).toBe('security-effect-requires-approval');
    expect(violation?.step).toBe('checkAccountBalance');
  });

  it('is satisfied by an approved flow in a headed session', () => {
    expect(
      checkSafety(approvedTransferFlow({ effects: CHANGES_AUTHORITY }), HEADED),
    ).toBeUndefined();
  });
});

describe('a declaration that demands nothing', () => {
  it('refuses nothing, headed or headless', () => {
    expect(checkSafety(balanceFlow(), HEADLESS)).toBeUndefined();
    expect(checkSafety(balanceFlow(), HEADED)).toBeUndefined();
  });
});
