/**
 * `clean` — semantic markup, roles, labels, test IDs.
 *
 * The tractable end of the spectrum: `byRole` and `byLabel` win throughout, so
 * a flow recorded here should contain almost no `css`. It is the reference the
 * other fixtures are read against — and the model `rebranded` has to preserve
 * the structure of.
 */
import { formatAmount } from '../data.js';
import { titleOf, type PageModel, type Screen, type TransferValues } from '../model.js';
import { DIALOG_STYLE, dialogOverlay, document, escape } from './html.js';

const STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#111;background:#f7f8fa}' +
  'header{background:#0b3d5c;color:#fff;padding:12px 24px}' +
  'main{max-width:44rem;margin:24px auto;padding:24px;background:#fff;border-radius:8px}' +
  'label{display:block;margin:12px 0 4px;font-weight:600}' +
  'input,select{padding:8px;width:100%;box-sizing:border-box}' +
  'button{margin-top:16px;padding:10px 18px;background:#0b3d5c;color:#fff;border:0;border-radius:4px}' +
  'dl{display:grid;grid-template-columns:12rem 1fr;gap:8px 16px}' +
  'dt{font-weight:600}' +
  DIALOG_STYLE;

function field(id: string, label: string, type = 'text', value = ''): string {
  return [
    `<label for="${id}">${escape(label)}</label>`,
    `<input id="${id}" name="${id}" type="${type}" data-testid="${id}" value="${escape(value)}">`,
  ].join('\n');
}

function chrome(body: string, signedInAs: string | undefined): string {
  return [
    '<header>',
    '  <span>Meridian Bank — Back Office</span>',
    signedInAs === undefined
      ? ''
      : `  <nav><a href="/search">Find an account</a> <a href="/transfer">New transfer</a> <a href="/logout">Sign out</a> <span>${escape(signedInAs)}</span></nav>`,
    '</header>',
    '<main>',
    body,
    '</main>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function transferFields(values: TransferValues): string {
  return [
    field('fromRef', 'From account', 'text', values.fromRef),
    field('toRef', 'To account', 'text', values.toRef),
    field('amount', 'Amount', 'text', values.amount),
    field('memo', 'Memo', 'text', values.memo),
  ].join('\n');
}

function screenBody(page: Screen): string {
  switch (page.screen) {
    case 'login':
      return [
        '<h1>Sign in</h1>',
        page.notice === undefined ? '' : `<p role="status">${escape(page.notice)}</p>`,
        page.error === undefined ? '' : `<p role="alert">${escape(page.error)}</p>`,
        '<form method="post" action="/login">',
        field('username', 'Username'),
        field('password', 'Password', 'password'),
        '<button type="submit">Sign in</button>',
        '</form>',
      ]
        .filter((line) => line !== '')
        .join('\n');

    case 'search':
      return [
        '<h1>Find an account</h1>',
        '<form method="get" action="/account">',
        field('ref', 'Account number'),
        '<button type="submit">Look up</button>',
        '</form>',
      ].join('\n');

    case 'account':
      return [
        '<h1>Account summary</h1>',
        '<dl>',
        `<dt>Account number</dt><dd data-testid="ref">${escape(page.account.ref)}</dd>`,
        `<dt>Account type</dt><dd data-testid="kind">${escape(page.account.kind)}</dd>`,
        `<dt>Account holder</dt><dd data-testid="owner">${escape(page.account.owner)}</dd>`,
        page.balanceOn === 'this-screen'
          ? `<dt>Current balance</dt><dd id="balance-value" data-testid="balance">${escape(formatAmount(page.account.balanceMinor))}</dd>`
          : '',
        '</dl>',
        page.balanceOn === 'next-screen'
          ? `<p><a href="/account/balances?ref=${escape(page.account.ref)}">Show balances</a></p>`
          : '',
      ]
        .filter((line) => line !== '')
        .join('\n');

    case 'account-balances':
      return [
        '<h1>Account balances</h1>',
        '<dl>',
        `<dt>Account number</dt><dd data-testid="ref">${escape(page.account.ref)}</dd>`,
        `<dt>Current balance</dt><dd id="balance-value" data-testid="balance">${escape(formatAmount(page.account.balanceMinor))}</dd>`,
        '</dl>',
      ].join('\n');

    case 'not-found':
      return [
        '<h1>No such account</h1>',
        `<p role="alert">No such account: ${escape(page.ref)}</p>`,
        '<p><a href="/search">Find an account</a></p>',
      ].join('\n');

    case 'denied':
      return [
        '<h1>Not authorized</h1>',
        `<p role="alert">Not authorized to view ${escape(page.ref)}.</p>`,
        `<p>This account requires the ${escape(page.requiredRole)} role.</p>`,
      ].join('\n');

    case 'transfer':
      return [
        '<h1>New transfer</h1>',
        page.error === undefined ? '' : `<p role="alert">${escape(page.error)}</p>`,
        '<form method="post" action="/transfer">',
        transferFields(page.values),
        '<button type="submit">Review transfer</button>',
        '</form>',
      ]
        .filter((line) => line !== '')
        .join('\n');

    case 'transfer-confirm':
      return [
        '<h1>Confirm transfer</h1>',
        '<dl>',
        `<dt>From account</dt><dd data-testid="fromRef">${escape(page.values.fromRef)}</dd>`,
        `<dt>To account</dt><dd data-testid="toRef">${escape(page.values.toRef)}</dd>`,
        `<dt>Amount</dt><dd data-testid="amount">${escape(page.values.amount)}</dd>`,
        `<dt>Memo</dt><dd data-testid="memo">${escape(page.values.memo)}</dd>`,
        '</dl>',
        '<form method="post" action="/transfer/confirm">',
        `<input type="hidden" name="fromRef" value="${escape(page.values.fromRef)}">`,
        `<input type="hidden" name="toRef" value="${escape(page.values.toRef)}">`,
        `<input type="hidden" name="amount" value="${escape(page.values.amount)}">`,
        `<input type="hidden" name="memo" value="${escape(page.values.memo)}">`,
        '<button type="submit">Confirm transfer</button>',
        '</form>',
      ].join('\n');

    case 'transfer-done':
      return [
        '<h1>Transfer complete</h1>',
        `<p role="status">Transfer complete. Reference ${escape(page.reference)}.</p>`,
        '<dl>',
        `<dt>Reference</dt><dd data-testid="reference">${escape(page.reference)}</dd>`,
        `<dt>Amount</dt><dd data-testid="amount">${escape(page.values.amount)}</dd>`,
        '</dl>',
      ].join('\n');

    case 'app-error':
      return ['<h1>Application error</h1>', `<p role="alert">${escape(page.detail)}</p>`].join(
        '\n',
      );
  }
}

export function renderClean(model: PageModel): string {
  const signedInAs =
    'user' in model.page ? `Signed in as ${model.page.user.displayName}` : undefined;

  return document({
    title: titleOf(model.page),
    style: STYLE,
    body: [
      chrome(screenBody(model.page), signedInAs),
      model.dialog === undefined ? '' : dialogOverlay(model.dialog, 'Dismiss'),
    ]
      .filter((line) => line !== '')
      .join('\n'),
  });
}
