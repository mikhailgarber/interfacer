/**
 * The capability itself: the recorded steps, in the order they were verified
 * against the application.
 *
 * Emitted by Interfacer from what discovery actually did — acting and recording
 * are one operation, so nothing here is a description of a run that happened
 * somewhere else. Every step carries the id the run record refers to.
 */
import {
  answer,
  asMoney,
  asText,
  byLabel,
  byRole,
  byText,
  css,
  extracted,
  field,
  Flow,
} from '@interfacer/dsl';

import { effects, inputFields } from './contract.js';

export const flow = new Flow({
  id: 'balanceLookup',
  input: inputFields,
  effects,
  allowlist: ['127.0.0.1'],
})
  .open(field('url'), { id: 'open' })
  .fillForm(
    [byLabel('Username'), css("input[data-testid='username']")],
    field('username'),
    { id: 'fillForm:label="Username"' },
  )
  .fillForm(
    [byLabel('Password'), css("input[data-testid='password']")],
    field('password'),
    { id: 'fillForm:label="Password"' },
  )
  .pressButton([byRole('button', 'Sign in'), css("button[type='submit']")], {
    id: 'pressButton:role=button name="Sign in"',
  })
  .checkpoint([byRole('heading', 'Find an account')], {
    id: 'checkpoint:role=heading name="Find an account"',
  })
  .fillForm(
    [
      byRole('textbox', 'Account number'),
      byLabel('Account number'),
      css("input[data-testid='ref']"),
    ],
    field('accountNumber'),
    { id: 'fillForm:role=textbox name="Account number"' },
  )
  .pressButton([byRole('button', 'Look up'), css("button[type='submit']")], {
    id: 'pressButton:role=button name="Look up"',
  })
  .checkpoint([byRole('heading', 'Account summary')], {
    id: 'checkpoint:role=heading name="Account summary"',
  })
  .extract(
    'balance',
    [css("dd[data-testid='balance']"), css('#balance-value')],
    asMoney,
    { id: 'extract:css="dd[data-testid=\'balance\']"' },
  )
  .extract('accountRef', [css("dd[data-testid='ref']")], asText, {
    id: 'extract:css="dd[data-testid=\'ref\']"',
  })
  .outcome(
    [
      byRole('heading', ['No such account', 'Account not found']),
      byRole('alert'),
      byText('No such account'),
      css('main [role=alert]'),
    ],
    answer('account_not_found', { accountNumber: field('accountNumber') }),
    { id: 'account_not_found' },
  )
  .returns(
    answer('success', {
      accountNumber: extracted('accountRef'),
      balance: extracted('balance'),
    }),
  );
