/**
 * A capability built the way discovery builds one, for the generator to emit.
 *
 * Every value is a described accessor, because that is what generation requires
 * and what the agent's tools will produce: the model calls `fillForm` naming an
 * input field, and Interfacer appends a step that knows which field it reads.
 * Written by hand here because Phase 7 has no model — the flow is the generator's
 * input either way.
 *
 * It drives the `clean` fixture: sign in, look an account up, read the balance,
 * with the two business outcomes that screen can produce.
 */
import {
  answer,
  asMoney,
  byLabel,
  byRole,
  byText,
  css,
  extracted,
  field,
  fields,
  Flow,
  join,
  literal,
  secret,
  text,
  type Effects,
  type Infer,
  type VariantStamp,
} from '@interfacer/dsl';

export const balanceInput = fields({
  url: text({ description: 'entry point' }),
  username: text({ description: 'the operator to sign in as' }),
  password: secret(),
  accountRef: text({ description: 'account to look up' }),
});

export type BalanceInput = Infer<typeof balanceInput>;

/**
 * The chains as discovery would record them: the semantic strategy that should
 * survive a release, backed by the selector observed to work, with accessible-name
 * alternatives where institutions word the same control differently.
 */
const USERNAME = [byLabel(['Username', 'Member ID']), css('input[name="username"]')] as const;
const PASSWORD = [byLabel('Password'), css('input[name="password"]')] as const;
const SIGN_IN = [byRole('button', 'Sign in')] as const;
const ACCOUNT_REF = [
  byLabel(['Account number', 'Member account']),
  css('input[name="ref"]'),
] as const;
const LOOK_UP = [byRole('button', ['Look up', 'Find'])] as const;
const ON_SEARCH_SCREEN = [byRole('heading', 'Find an account'), css('input[name="ref"]')] as const;
const BALANCE = [css('#balance-value'), css('.balance')] as const;

export function balanceCapability(effects?: Effects) {
  return new Flow({
    id: 'checkAccountBalance',
    input: balanceInput,
    ...(effects === undefined ? {} : { effects }),
  })
    .open(field('url'), { id: 'login.open' })
    .fillForm(USERNAME, field('username'), { id: 'login.username' })
    .fillForm(PASSWORD, field('password'), { id: 'login.password' })
    .pressButton(SIGN_IN, { id: 'login.submit' })
    .checkpoint(ON_SEARCH_SCREEN, { id: 'search.reached' })
    .fillForm(ACCOUNT_REF, field('accountRef'), { id: 'search.ref' })
    .pressButton(LOOK_UP, { id: 'search.submit' })
    .outcome(
      [byText('No such account')],
      answer('account_not_found', { accountRef: field('accountRef') }),
      {
        id: 'account_not_found',
      },
    )
    .outcome(
      [byText('Not authorized')],
      answer('permission_denied', { requiredRole: literal('TELLER') }),
      {
        id: 'permission_denied',
      },
    )
    .checkpoint(BALANCE, { id: 'balance.present' })
    .extract('balance', BALANCE, asMoney, { id: 'balance.read' })
    .returns(answer('ok', { balance: extracted('balance') }));
}

/** The same capability with a path joined onto the entry point, and a pause. */
export function attendedCapability() {
  return new Flow({ id: 'checkAccountBalance', input: balanceInput })
    .open(join(field('url'), literal('/')), { id: 'login.open' })
    .fillForm(USERNAME, field('username'), { id: 'login.username' })
    .fillForm(PASSWORD, field('password'), { id: 'login.password' })
    .pressButton(SIGN_IN, { id: 'login.submit' })
    .pauseForInput('mfaCode', {
      prompt: 'Enter the code sent to your device',
      within: '30s',
      id: 'login.mfa',
    })
    .checkpoint(ON_SEARCH_SCREEN, { id: 'search.reached' })
    .returns(answer('ok'));
}

export const variant: VariantStamp = {
  capability: 'checkAccountBalance',
  vendor: 'CoreBankingCo',
  appVersion: '11.4',
  recordedAgainst: 'clean.fixture.invalid',
  recordedOn: '2026-09-01',
};
