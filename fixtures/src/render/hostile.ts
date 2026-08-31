/**
 * `hostile` — the honest floor.
 *
 * Everything here is something real back-office software does:
 *
 * - **Nested tables** for layout, three deep.
 * - **Generated class names** (`css-1x2y3z`, `_a7Bq9`) that change on any
 *   rebuild. They are in the markup so a fixture *has* them; they are never a
 *   durable target, which is why the design excludes them from a recorded chain
 *   outright.
 * - **Accessible names that differ from visible text.** The sign-in button reads
 *   "Sign in" but is announced as "Submit credentials", so
 *   `byRole('button', 'Sign in')` finds nothing while `byText('Sign in')` and
 *   `byRole('button', 'Submit credentials')` both work. A model shown only a
 *   screenshot would get this wrong; a model shown the accessibility tree gets
 *   it right, which is the reason the tree is what it is shown.
 * - **Duplicate labels.** Two inputs on the search screen are both labelled
 *   "ID". `byLabel('ID')` matches two elements, and the design's rule there is
 *   a hard failure, never "take the first".
 * - **A separate document** (an iframe) holding a help panel. It is deliberately
 *   off the critical path: the flows can be completed without ever entering it,
 *   so this fixture does not force a frame-traversal decision the design does
 *   not make. See docs/testing.md.
 */
import { formatAmount } from '../data.js';
import { titleOf, type PageModel, type Screen, type TransferValues } from '../model.js';
import { DIALOG_STYLE, dialogOverlay, document, escape } from './html.js';

const STYLE =
  'body{font:12px Tahoma,sans-serif;background:#c9ccd1;margin:0}' +
  'table{border-collapse:collapse}' +
  '.css-1x2y3z{background:#3a3f47;color:#eee;padding:6px 10px}' +
  '._a7Bq9{background:#fff;border:1px solid #9aa0a6;padding:8px;margin:8px}' +
  '.css-8f0e2d{font-weight:bold;padding:3px 6px}' +
  '.css-b41c7a{padding:3px 6px}' +
  '._q3Wm1{color:#a30000;font-weight:bold}' +
  'iframe{width:100%;height:80px;border:1px inset #9aa0a6}' +
  DIALOG_STYLE;

/** Nested three deep, because that is what the markup under test looks like. */
function nest(inner: string): string {
  return [
    '<table class="css-4b8a1e"><tr><td>',
    '<table class="css-9d2f6c"><tr><td>',
    `<table class="css-71ea3b"><tr><td>${inner}</td></tr></table>`,
    '</td></tr></table>',
    '</td></tr></table>',
  ].join('\n');
}

function heading(text: string): string {
  // A visual heading that is not a heading: no `<h1>`, so `byRole('heading')`
  // finds nothing and a checkpoint has to fall back to text.
  return `<div class="css-8f0e2d">${escape(text)}</div>`;
}

function labelled(id: string, visible: string, name: string, type = 'text', value = ''): string {
  return [
    `<tr><td class="css-b41c7a"><label for="${id}">${escape(visible)}</label></td>`,
    `<td><input class="css-3e9a7f" id="${id}" name="${name}" type="${type}" value="${escape(value)}" aria-label="${escape(name)}"></td></tr>`,
  ].join('\n');
}

function mismatchedButton(visible: string, announced: string): string {
  return `<button class="_a7Bq9x" type="submit" aria-label="${escape(announced)}">${escape(visible)}</button>`;
}

function fact(term: string, value: string, hook: string): string {
  return `<tr><td class="css-b41c7a">${escape(term)}</td><td class="css-${hook}">${escape(value)}</td></tr>`;
}

function transferRows(values: TransferValues): string {
  return [
    labelled('f_1', 'From', 'fromRef', 'text', values.fromRef),
    labelled('f_2', 'To', 'toRef', 'text', values.toRef),
    labelled('f_3', 'Amount', 'amount', 'text', values.amount),
    labelled('f_4', 'Memo', 'memo', 'text', values.memo),
  ].join('\n');
}

const HELP_FRAME =
  '<iframe title="Help" srcdoc="&lt;p&gt;Enter an account reference such as ACC-1001.&lt;/p&gt;"></iframe>';

function body(page: Screen): string {
  switch (page.screen) {
    case 'login':
      return nest(
        [
          heading('Sign in'),
          page.notice === undefined ? '' : `<div class="_q3Wm1">${escape(page.notice)}</div>`,
          page.error === undefined ? '' : `<div class="_q3Wm1">${escape(page.error)}</div>`,
          '<form method="post" action="/login"><table>',
          labelled('u_1', 'User', 'username'),
          labelled('u_2', 'Pass', 'password', 'password'),
          '</table>',
          // Reads "Sign in", announces "Submit credentials".
          mismatchedButton('Sign in', 'Submit credentials'),
          '</form>',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );

    case 'search':
      return nest(
        [
          heading('Find an account'),
          '<form method="get" action="/account"><table>',
          // Two fields, one label. `byLabel('ID')` is ambiguous here by design.
          labelled('s_1', 'ID', 'ref'),
          labelled('s_2', 'ID', 'branch'),
          '</table>',
          mismatchedButton('Look up', 'Search accounts'),
          '</form>',
          HELP_FRAME,
        ].join('\n'),
      );

    case 'account':
      return nest(
        [
          heading('Account summary'),
          '<table>',
          fact('Account number', page.account.ref, 'ref'),
          fact('Account type', page.account.kind, 'kind'),
          fact('Account holder', page.account.owner, 'owner'),
          page.balanceOn === 'this-screen'
            ? fact('Current balance', formatAmount(page.account.balanceMinor), 'bal')
            : '',
          '</table>',
          page.balanceOn === 'next-screen'
            ? `<a href="/account/balances?ref=${escape(page.account.ref)}">Show balances</a>`
            : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );

    case 'account-balances':
      return nest(
        [
          heading('Account balances'),
          '<table>',
          fact('Account number', page.account.ref, 'ref'),
          fact('Current balance', formatAmount(page.account.balanceMinor), 'bal'),
          '</table>',
        ].join('\n'),
      );

    case 'not-found':
      return nest(
        [
          heading('No such account'),
          `<div class="_q3Wm1">No such account: ${escape(page.ref)}</div>`,
          '<a href="/search">Find an account</a>',
        ].join('\n'),
      );

    case 'denied':
      return nest(
        [
          heading('Not authorized'),
          `<div class="_q3Wm1">Not authorized to view ${escape(page.ref)}.</div>`,
          `<div>This account requires the ${escape(page.requiredRole)} role.</div>`,
        ].join('\n'),
      );

    case 'transfer':
      return nest(
        [
          heading('New transfer'),
          page.error === undefined ? '' : `<div class="_q3Wm1">${escape(page.error)}</div>`,
          '<form method="post" action="/transfer"><table>',
          transferRows(page.values),
          '</table>',
          mismatchedButton('Review transfer', 'Review'),
          '</form>',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );

    case 'transfer-confirm':
      return nest(
        [
          heading('Confirm transfer'),
          '<table>',
          fact('From account', page.values.fromRef, 'from'),
          fact('To account', page.values.toRef, 'to'),
          fact('Amount', page.values.amount, 'amt'),
          fact('Memo', page.values.memo, 'memo'),
          '</table>',
          '<form method="post" action="/transfer/confirm">',
          `<input type="hidden" name="fromRef" value="${escape(page.values.fromRef)}">`,
          `<input type="hidden" name="toRef" value="${escape(page.values.toRef)}">`,
          `<input type="hidden" name="amount" value="${escape(page.values.amount)}">`,
          `<input type="hidden" name="memo" value="${escape(page.values.memo)}">`,
          // The point of no return, announced as something else entirely.
          mismatchedButton('Confirm transfer', 'Commit'),
          '</form>',
        ].join('\n'),
      );

    case 'transfer-done':
      return nest(
        [
          heading('Transfer complete'),
          `<div>Transfer complete. Reference ${escape(page.reference)}.</div>`,
          '<table>',
          fact('Reference', page.reference, 'ref'),
          fact('Amount', page.values.amount, 'amt'),
          '</table>',
        ].join('\n'),
      );

    case 'app-error':
      return nest(
        [heading('Application error'), `<div class="_q3Wm1">${escape(page.detail)}</div>`].join(
          '\n',
        ),
      );
  }
}

export function renderHostile(model: PageModel): string {
  const signedIn = 'user' in model.page ? model.page.user.displayName : undefined;

  const parts = [
    '<div class="css-1x2y3z">MERIDIAN CORE BANKING</div>',
    signedIn === undefined
      ? ''
      : `<div class="css-1x2y3z"><a href="/search">Find an account</a> <a href="/transfer">New transfer</a> <a href="/logout">Sign out</a> ${escape(signedIn)}</div>`,
    `<div class="_a7Bq9">${body(model.page)}</div>`,
    model.dialog === undefined ? '' : dialogOverlay(model.dialog, 'OK'),
  ].filter((line) => line !== '');

  return document({ title: titleOf(model.page), style: STYLE, body: parts.join('\n') });
}
