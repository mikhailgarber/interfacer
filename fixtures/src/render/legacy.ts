/**
 * `legacy` — server-rendered, table layout, no test IDs, no `<label>`.
 *
 * The middle of the spectrum, and the shape most back-office systems actually
 * have. Field names sit in a table cell beside the input rather than in a
 * `<label for>`, so there is no programmatic label association and `byLabel`
 * finds nothing. What is left:
 *
 * - `byRole` still works for submit buttons, because `<input type="submit">`
 *   takes its accessible name from `value`. A poor tree is still a tree.
 * - `byText` finds the field names, as text in a cell.
 * - `css` finds the rest, via **meaningful** class names — `class="balance"`,
 *   not `class="css-1x2y3z"`. The design excludes generated class names and
 *   positional paths outright, so this fixture exercises the chain falling
 *   through to `css` without exercising the thing that is never recorded.
 */
import { formatAmount } from '../data.js';
import { titleOf, type PageModel, type Screen, type TransferValues } from '../model.js';
import { DIALOG_STYLE, dialogOverlay, document, escape } from './html.js';

const STYLE =
  'body{font-family:Verdana,Arial,sans-serif;font-size:13px;background:#dfe3e8;margin:0}' +
  'table{border-collapse:collapse}' +
  'td{padding:4px 8px;vertical-align:top}' +
  '.banner{background:#26405e;color:#fff;padding:8px}' +
  '.frame{margin:12px;background:#fff;border:2px outset #b8bec6;padding:10px}' +
  '.msg{color:#8a0000;font-weight:bold}' +
  DIALOG_STYLE;

function row(name: string, control: string): string {
  return `<tr><td>${escape(name)}</td><td>${control}</td></tr>`;
}

function input(name: string, type = 'text', value = ''): string {
  return `<input type="${type}" name="${name}" value="${escape(value)}" size="28">`;
}

function submit(label: string): string {
  return `<input type="submit" value="${escape(label)}">`;
}

function transferRows(values: TransferValues): string {
  return [
    row('From account', input('fromRef', 'text', values.fromRef)),
    row('To account', input('toRef', 'text', values.toRef)),
    row('Amount', input('amount', 'text', values.amount)),
    row('Memo', input('memo', 'text', values.memo)),
  ].join('\n');
}

function fact(name: string, value: string, className?: string): string {
  const cell = className === undefined ? '<td>' : `<td class="${className}">`;
  return `<tr><td>${escape(name)}</td>${cell}${escape(value)}</td></tr>`;
}

function body(page: Screen): string {
  switch (page.screen) {
    case 'login':
      return [
        '<table><tr><td><b>Sign in</b></td></tr></table>',
        page.notice === undefined ? '' : `<p class="msg">${escape(page.notice)}</p>`,
        page.error === undefined ? '' : `<p class="msg">${escape(page.error)}</p>`,
        '<form method="post" action="/login"><table>',
        row('Username', input('username')),
        row('Password', input('password', 'password')),
        `<tr><td></td><td>${submit('Sign in')}</td></tr>`,
        '</table></form>',
      ]
        .filter((line) => line !== '')
        .join('\n');

    case 'search':
      return [
        '<table><tr><td><b>Find an account</b></td></tr></table>',
        '<form method="get" action="/account"><table>',
        row('Account number', input('ref')),
        `<tr><td></td><td>${submit('Look up')}</td></tr>`,
        '</table></form>',
      ].join('\n');

    case 'account':
      return [
        '<table><tr><td><b>Account summary</b></td></tr></table>',
        '<table class="detail">',
        fact('Account number', page.account.ref, 'ref'),
        fact('Account type', page.account.kind, 'kind'),
        fact('Account holder', page.account.owner, 'owner'),
        page.balanceOn === 'this-screen'
          ? fact('Current balance', formatAmount(page.account.balanceMinor), 'balance')
          : '',
        '</table>',
        page.balanceOn === 'next-screen'
          ? `<p><a href="/account/balances?ref=${escape(page.account.ref)}">Show balances</a></p>`
          : '',
      ]
        .filter((line) => line !== '')
        .join('\n');

    case 'account-balances':
      return [
        '<table><tr><td><b>Account balances</b></td></tr></table>',
        '<table class="detail">',
        fact('Account number', page.account.ref, 'ref'),
        fact('Current balance', formatAmount(page.account.balanceMinor), 'balance'),
        '</table>',
      ].join('\n');

    case 'not-found':
      return [
        '<table><tr><td><b>No such account</b></td></tr></table>',
        `<p class="msg">No such account: ${escape(page.ref)}</p>`,
        '<p><a href="/search">Find an account</a></p>',
      ].join('\n');

    case 'denied':
      return [
        '<table><tr><td><b>Not authorized</b></td></tr></table>',
        `<p class="msg">Not authorized to view ${escape(page.ref)}.</p>`,
        `<p>This account requires the ${escape(page.requiredRole)} role.</p>`,
      ].join('\n');

    case 'transfer':
      return [
        '<table><tr><td><b>New transfer</b></td></tr></table>',
        page.error === undefined ? '' : `<p class="msg">${escape(page.error)}</p>`,
        '<form method="post" action="/transfer"><table>',
        transferRows(page.values),
        `<tr><td></td><td>${submit('Review transfer')}</td></tr>`,
        '</table></form>',
      ]
        .filter((line) => line !== '')
        .join('\n');

    case 'transfer-confirm':
      return [
        '<table><tr><td><b>Confirm transfer</b></td></tr></table>',
        '<table class="detail">',
        fact('From account', page.values.fromRef, 'fromRef'),
        fact('To account', page.values.toRef, 'toRef'),
        fact('Amount', page.values.amount, 'amount'),
        fact('Memo', page.values.memo, 'memo'),
        '</table>',
        '<form method="post" action="/transfer/confirm">',
        `<input type="hidden" name="fromRef" value="${escape(page.values.fromRef)}">`,
        `<input type="hidden" name="toRef" value="${escape(page.values.toRef)}">`,
        `<input type="hidden" name="amount" value="${escape(page.values.amount)}">`,
        `<input type="hidden" name="memo" value="${escape(page.values.memo)}">`,
        submit('Confirm transfer'),
        '</form>',
      ].join('\n');

    case 'transfer-done':
      return [
        '<table><tr><td><b>Transfer complete</b></td></tr></table>',
        `<p>Transfer complete. Reference ${escape(page.reference)}.</p>`,
        '<table class="detail">',
        fact('Reference', page.reference, 'reference'),
        fact('Amount', page.values.amount, 'amount'),
        '</table>',
      ].join('\n');

    case 'app-error':
      return [
        '<table><tr><td><b>Application error</b></td></tr></table>',
        `<p class="msg">${escape(page.detail)}</p>`,
      ].join('\n');
  }
}

export function renderLegacy(model: PageModel): string {
  const signedIn = 'user' in model.page ? model.page.user.displayName : undefined;

  const parts = [
    '<div class="banner">MERIDIAN CORE BANKING v11.4</div>',
    signedIn === undefined
      ? ''
      : `<div class="banner"><a href="/search">Find an account</a> | <a href="/transfer">New transfer</a> | <a href="/logout">Sign out</a> | ${escape(signedIn)}</div>`,
    `<div class="frame">${body(model.page)}</div>`,
    model.dialog === undefined ? '' : dialogOverlay(model.dialog, 'Dismiss'),
  ].filter((line) => line !== '');

  return document({ title: titleOf(model.page), style: STYLE, body: parts.join('\n') });
}
