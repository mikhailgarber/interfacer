/**
 * Flows authored by hand, for the integration tier to run.
 *
 * These stand in for what Interfacer's generator will emit. Tests build a `Flow`
 * and hand it to the engine; they never call `page.click()`, because the suite
 * exists to prove the verification order, retry gating, allowlist enforcement
 * and record emission that only happen inside the engine's step cycle — not
 * Playwright's behaviour.
 *
 * The target chains are written the way discovery would record them: the
 * semantic strategy that should survive a release, backed by the selector
 * observed to work. That is what lets one flow run against `clean`, `rebranded`
 * *and* `legacy` — and what makes `legacy` report drift, since there the
 * semantic strategy is the one that no longer resolves.
 */
import {
  byLabel,
  byRole,
  byText,
  css,
  fields,
  Flow,
  secret,
  text,
  type Duration,
  type Infer,
} from '@interfacer/dsl';

export const balanceInput = fields({
  url: text({ description: 'entry point' }),
  username: text(),
  password: secret(),
  accountRef: text({ description: 'account to look up' }),
});

export type BalanceInput = Infer<typeof balanceInput>;

/**
 * Accessible-name alternatives absorb the wording tier: one institution says
 * "Account number" where another says "Member account". They are admitted for a
 * name and nothing else — a target that could vary its strategy per tenant would
 * be an override layer wearing a different hat.
 */
export const USERNAME_FIELD = [
  byLabel(['Username', 'Member ID']),
  css('input[name="username"]'),
] as const;
export const PASSWORD_FIELD = [byLabel('Password'), css('input[name="password"]')] as const;
export const SIGN_IN = [byRole('button', 'Sign in')] as const;
export const ACCOUNT_REF_FIELD = [
  byLabel(['Account number', 'Member account']),
  css('input[name="ref"]'),
] as const;
export const LOOK_UP = [byRole('button', ['Look up', 'Find'])] as const;

/** `clean` and `rebranded` have a heading; `legacy` does not, so the chain falls through. */
export const ON_SEARCH_SCREEN = [
  byRole('heading', 'Find an account'),
  css('input[name="ref"]'),
] as const;
export const BALANCE = [css('#balance-value'), css('.balance')] as const;

export const NO_SUCH_ACCOUNT = [byText('No such account'), byText('Account not found')] as const;
export const NOT_AUTHORIZED = [byText('Not authorized'), byText('Access refused')] as const;

export type BalanceAnswer =
  | { status: 'ok'; balance: number }
  | { status: 'account_not_found'; accountRef: string }
  | { status: 'permission_denied'; requiredRole: string };

/** `$1,250.75` to `1250.75`. */
export function parseMoney(rendered: string): number {
  return Number(rendered.replace(/[^0-9.-]/g, ''));
}

export interface BalanceFlowOptions {
  /**
   * Drop the declared detectors.
   *
   * Half of the pair that proves the verification order rather than assuming
   * it: the same page state that returns an outcome with detectors declared has
   * to become a hard failure without them.
   */
  readonly withOutcomes?: boolean;
}

/** Sign in, look an account up, read its balance. Read-only, so no `.commit()`. */
export function balanceFlow(options: BalanceFlowOptions = {}) {
  const start = new Flow({ id: 'checkAccountBalance', input: balanceInput })
    .open((i) => i.url, { id: 'login.open' })
    .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
    .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
    .pressButton(SIGN_IN, { id: 'login.submit' })
    .checkpoint(ON_SEARCH_SCREEN, { id: 'search.reached' })
    .fillForm(ACCOUNT_REF_FIELD, (i) => i.accountRef, { id: 'search.ref' })
    .pressButton(LOOK_UP, { id: 'search.submit' });

  const declared =
    options.withOutcomes === false
      ? start
      : start
          .outcome(
            NO_SUCH_ACCOUNT,
            (i) => ({ status: 'account_not_found' as const, accountRef: i.accountRef }),
            { id: 'outcome.notFound' },
          )
          .outcome(
            NOT_AUTHORIZED,
            () => ({ status: 'permission_denied' as const, requiredRole: 'TELLER' }),
            {
              id: 'outcome.denied',
            },
          );

  return declared
    .checkpoint(BALANCE, { id: 'balance.present' })
    .extract('balance', BALANCE, parseMoney, { id: 'balance.read' })
    .returns(({ balance }) => ({ status: 'ok' as const, balance }));
}

export const transferInput = fields({
  url: text(),
  username: text(),
  password: secret(),
  fromRef: text(),
  toRef: text(),
  amount: text(),
});

export type TransferInput = Infer<typeof transferInput>;

/**
 * A mutating capability, so it has a point of no return.
 *
 * `.commit()` marks the confirmation press, not the review press: the review is
 * reversible and the confirmation is not. A reader scanning this flow can see
 * exactly where it stops being reversible.
 */
export function transferFlow() {
  return new Flow({ id: 'transferFunds', input: transferInput })
    .open((i) => i.url, { id: 'login.open' })
    .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
    .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
    .pressButton(SIGN_IN, { id: 'login.submit' })
    .open((i) => `${i.url}/transfer`, { id: 'transfer.open' })
    .fillForm([byLabel('From account'), css('input[name="fromRef"]')], (i) => i.fromRef, {
      id: 'transfer.from',
    })
    .fillForm([byLabel('To account'), css('input[name="toRef"]')], (i) => i.toRef, {
      id: 'transfer.to',
    })
    .fillForm([byLabel('Amount'), css('input[name="amount"]')], (i) => i.amount, {
      id: 'transfer.amount',
    })
    .pressButton([byRole('button', 'Review transfer')], { id: 'transfer.review' })
    .checkpoint([byRole('heading', 'Confirm transfer')], { id: 'transfer.confirmReached' })
    .commit([byRole('button', 'Confirm transfer')], { id: 'transfer.commit' })
    .checkpoint([byRole('heading', 'Transfer complete')], { id: 'transfer.done' })
    .extract('reference', [css('[data-testid="reference"]')], (value) => value, {
      id: 'transfer.reference',
    })
    .returns(({ reference }) => ({ status: 'ok' as const, reference }));
}

/**
 * `hostile` needs its own login targets, and that is the point of `hostile`.
 *
 * Its sign-in button reads "Sign in" and is announced as "Submit credentials",
 * and its inputs carry an `aria-label` that overrides the visible `<label>`. A
 * flow recorded against `clean` does not survive here — nothing absorbs that,
 * which is what makes it the honest floor.
 */
export function hostileLogin<F extends Flow<typeof balanceInput>>(flow: F): F {
  flow
    .open((i) => i.url, { id: 'login.open' })
    .fillForm([css('input[name="username"]')], (i) => i.username, { id: 'login.username' })
    .fillForm([css('input[name="password"]')], (i) => i.password, { id: 'login.password' })
    .pressButton([byRole('button', 'Submit credentials')], { id: 'login.submit' });
  return flow;
}

// ---- flows that pause ------------------------------------------------------

export const attendedInput = fields({
  url: text({ description: 'entry point' }),
  username: text(),
  password: secret(),
});

export type AttendedInput = Infer<typeof attendedInput>;

export interface AttendedOptions {
  /**
   * The bound on the pauses a human answers.
   *
   * Short by default, because a test that waits out a real bound is a test
   * nobody runs. The bound is the thing under test, not the duration.
   */
  readonly within?: Duration;
  /**
   * The bound on the surface wait, kept separate and generous.
   *
   * A test tightening the human bound to prove an expiry should not also be
   * tightening how long the page has to load, or it would be unclear which one
   * failed.
   */
  readonly surfaceWithin?: Duration;
}

export const MFA_PROMPT = 'Which account should I look up?';
export const OPERATOR_REASON = 'Take the session and clear anything in the way';

/**
 * Sign in, wait for the screen, hand the session to a human, then ask for a
 * value that was not knowable in advance.
 *
 * Three of the four pause kinds in one flow — `awaiting-surface`,
 * `awaiting-action` and `awaiting-input` — because they are the same primitive
 * differing only in the resolver, and a flow that mixes them is what makes that
 * claim checkable rather than three flows that each prove one.
 *
 * The account reference arrives mid-run and is spent through the accessor's
 * second argument, which is how a `.pauseForInput()` value reaches the page.
 */
export function attendedBalanceFlow(options: AttendedOptions = {}) {
  const within = options.within ?? '5s';

  return new Flow({ id: 'attendedBalance', input: attendedInput })
    .open((i) => i.url, { id: 'login.open' })
    .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
    .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
    .pressButton(SIGN_IN, { id: 'login.submit' })
    .pauseUntil(ON_SEARCH_SCREEN, { within: options.surfaceWithin ?? '10s', id: 'search.arrive' })
    .checkpoint(ON_SEARCH_SCREEN, { id: 'search.reached' })
    .pauseForOperator(OPERATOR_REASON, { within, id: 'search.handover' })
    .pauseForInput('accountRef', { prompt: MFA_PROMPT, within, id: 'search.askRef' })
    .fillForm(ACCOUNT_REF_FIELD, (_i, got) => got.accountRef, { id: 'search.ref' })
    .pressButton(LOOK_UP, { id: 'search.submit' })
    .checkpoint(BALANCE, { id: 'balance.present' })
    .extract('balance', BALANCE, parseMoney, { id: 'balance.read' })
    .returns(({ balance }) => ({ status: 'ok' as const, balance }));
}

/**
 * The transfer, with the approval the design requires before a `.commit()`.
 *
 * The approval sits between the confirmation checkpoint and the point of no
 * return, which is the only place it can sit: approval that follows the commit
 * approves nothing, and the fixture has a separate confirmation screen for
 * exactly this reason.
 */
export function approvedTransferFlow(options: AttendedOptions = {}) {
  const within = options.within ?? '5s';

  return new Flow({ id: 'approvedTransfer', input: transferInput })
    .open((i) => i.url, { id: 'login.open' })
    .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
    .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
    .pressButton(SIGN_IN, { id: 'login.submit' })
    .open((i) => `${i.url}/transfer`, { id: 'transfer.open' })
    .fillForm([byLabel('From account'), css('input[name="fromRef"]')], (i) => i.fromRef, {
      id: 'transfer.from',
    })
    .fillForm([byLabel('To account'), css('input[name="toRef"]')], (i) => i.toRef, {
      id: 'transfer.to',
    })
    .fillForm([byLabel('Amount'), css('input[name="amount"]')], (i) => i.amount, {
      id: 'transfer.amount',
    })
    .pressButton([byRole('button', 'Review transfer')], { id: 'transfer.review' })
    .checkpoint([byRole('heading', 'Confirm transfer')], { id: 'transfer.confirmReached' })
    .pauseForApproval('Send this transfer?', { within, id: 'transfer.approve' })
    .commit([byRole('button', 'Confirm transfer')], { id: 'transfer.commit' })
    .checkpoint([byRole('heading', 'Transfer complete')], { id: 'transfer.done' })
    .extract('reference', [css('[data-testid="reference"]')], (value) => value, {
      id: 'transfer.reference',
    })
    .returns(({ reference }) => ({ status: 'ok' as const, reference }));
}

/**
 * A flow that pauses somewhere its last checkpoint no longer describes.
 *
 * `search.reached` holds on the search screen; by the time the approval is
 * asked the flow has navigated to the account screen, so re-asserting it on
 * resume fails. Not a contrived setup — it is the shape of the rule, which is
 * that a flow may not assume where it is once a human has touched the session,
 * and a pause placed after the flow has moved on has no known state to return
 * to.
 */
export function staleCheckpointFlow(options: AttendedOptions = {}) {
  const within = options.within ?? '5s';

  return new Flow({ id: 'staleCheckpoint', input: balanceInput })
    .open((i) => i.url, { id: 'login.open' })
    .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
    .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
    .pressButton(SIGN_IN, { id: 'login.submit' })
    .checkpoint(ON_SEARCH_SCREEN, { id: 'search.reached' })
    .fillForm(ACCOUNT_REF_FIELD, (i) => i.accountRef, { id: 'search.ref' })
    .pressButton(LOOK_UP, { id: 'search.submit' })
    .pauseForApproval('Read this balance?', { within, id: 'balance.approve' })
    .checkpoint(BALANCE, { id: 'balance.present' })
    .returns(() => ({ status: 'ok' as const }));
}

/**
 * The same shape as {@link staleCheckpointFlow}, but waiting on a surface.
 *
 * The contrast is the point: in the same position, a pause a *human* answers
 * re-asserts `search.reached` and fails, and a surface wait does not re-assert
 * at all and succeeds. Polling is not a human, and re-asserting after it would
 * make every flow that waits for a *new* screen fail on the old one.
 */
export function staleSurfaceWaitFlow() {
  return new Flow({ id: 'staleSurfaceWait', input: balanceInput })
    .open((i) => i.url, { id: 'login.open' })
    .fillForm(USERNAME_FIELD, (i) => i.username, { id: 'login.username' })
    .fillForm(PASSWORD_FIELD, (i) => i.password, { id: 'login.password' })
    .pressButton(SIGN_IN, { id: 'login.submit' })
    .checkpoint(ON_SEARCH_SCREEN, { id: 'search.reached' })
    .fillForm(ACCOUNT_REF_FIELD, (i) => i.accountRef, { id: 'search.ref' })
    .pressButton(LOOK_UP, { id: 'search.submit' })
    .pauseUntil(BALANCE, { within: '5s', id: 'balance.arrive' })
    .checkpoint(BALANCE, { id: 'balance.present' })
    .returns(() => ({ status: 'ok' as const }));
}

/** A pause whose target never arrives, so the bound is what ends it. */
export function neverArrivesFlow(options: AttendedOptions = {}) {
  return new Flow({ id: 'neverArrives', input: attendedInput })
    .open((i) => i.url, { id: 'login.open' })
    .pauseUntil([byRole('heading', 'A screen this application does not have')], {
      within: options.within ?? '600ms',
      id: 'never.arrive',
    })
    .returns(() => ({ status: 'ok' as const }));
}
