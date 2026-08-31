/**
 * `rebranded` — `clean` restyled and reworded, structurally identical.
 *
 * This is the fixture that earns its keep beyond locator difficulty: it turns
 * "semantic targeting is branding-invariant" from an assertion into a test. A
 * flow whose targets lead with `role` and `label` should replay here unchanged,
 * because a stylesheet and a logo are not what `role` describes.
 *
 * It is written as its own module rather than as `clean` with a theme argument,
 * on purpose. Sharing the markup would make the structure-preservation test
 * tautological — of course two calls to the same function agree. Written
 * separately, the test is a real check, and it is what would catch a later edit
 * that quietly restructured a screen while calling it a rebrand.
 *
 * Two tiers of difference are exercised together, and the design treats them
 * separately:
 *
 * - **branding** — colours, class names, chrome, logo. Absorbed by semantic
 *   targeting; nothing about a flow needs to change.
 * - **wording** — "Member" where the other says "Customer". Absorbed by a target
 *   chain whose accessible name admits alternatives. {@link REBRANDED_WORDING}
 *   is the exhaustive list, so a test never has to hardcode the same string
 *   twice.
 */
import { formatAmount } from '../data.js';
import { titleOf, type PageModel, type Screen, type TransferValues } from '../model.js';
import { DIALOG_STYLE, dialogOverlay, document, escape } from './html.js';

/**
 * Every accessible name this fixture spells differently from `clean`.
 *
 * Exhaustive by construction: anything not listed here reads identically on
 * both, which is what lets a Phase 3 test assert that a flow replays unchanged
 * except where an alternative was declared.
 */
export const REBRANDED_WORDING = Object.freeze({
  brand: 'Northgate Credit Union — Member Services',
  usernameLabel: 'Member ID',
  accountRefLabel: 'Member account',
  lookupButton: 'Find',
  balanceTerm: 'Available balance',
  notFoundHeading: 'Account not found',
  deniedHeading: 'Access refused',
});

/**
 * The document title too, not only the heading.
 *
 * Missing this would leave the fixture half-reworded: a detector keyed on the
 * old wording would still match the title and the rebrand would look more
 * survivable than it is.
 */
function rebrandedTitle(page: Screen): string {
  switch (page.screen) {
    case 'not-found':
      return REBRANDED_WORDING.notFoundHeading;
    case 'denied':
      return REBRANDED_WORDING.deniedHeading;
    default:
      return titleOf(page);
  }
}

const STYLE =
  'body{font:15px/1.6 Georgia,serif;margin:0;color:#2b2b2b;background:#fffaf3}' +
  '.masthead{background:#7a1f2b;color:#fff8f0;padding:16px 32px}' +
  '.sheet{max-width:48rem;margin:32px auto;padding:32px;background:#fff;border:1px solid #e6d8c8}' +
  '.field-name{display:block;margin:14px 0 6px;letter-spacing:.02em;text-transform:uppercase}' +
  '.entry{padding:9px;width:100%;box-sizing:border-box;border:1px solid #c9b7a4}' +
  '.action{margin-top:18px;padding:11px 20px;background:#7a1f2b;color:#fff;border:0}' +
  '.facts{display:grid;grid-template-columns:13rem 1fr;gap:9px 18px}' +
  '.facts dt{font-variant:small-caps}' +
  DIALOG_STYLE;

function entry(id: string, name: string, type = 'text', value = ''): string {
  return [
    `<label class="field-name" for="${id}">${escape(name)}</label>`,
    `<input class="entry" id="${id}" name="${id}" type="${type}" data-testid="${id}" value="${escape(value)}">`,
  ].join('\n');
}

function shell(inner: string, greeting: string | undefined): string {
  const parts = ['<header class="masthead">', `  <span>${escape(REBRANDED_WORDING.brand)}</span>`];

  if (greeting !== undefined) {
    parts.push(
      `  <nav><a href="/search">Find an account</a> <a href="/transfer">New transfer</a> <a href="/logout">Sign out</a> <span>${escape(greeting)}</span></nav>`,
    );
  }

  parts.push('</header>', '<main class="sheet">', inner, '</main>');
  return parts.join('\n');
}

function moneyMoveFields(values: TransferValues): string {
  return [
    entry('fromRef', 'From account', 'text', values.fromRef),
    entry('toRef', 'To account', 'text', values.toRef),
    entry('amount', 'Amount', 'text', values.amount),
    entry('memo', 'Memo', 'text', values.memo),
  ].join('\n');
}

function inner(page: Screen): string {
  switch (page.screen) {
    case 'login': {
      const lines = ['<h1>Sign in</h1>'];
      if (page.notice !== undefined) {
        lines.push(`<p role="status">${escape(page.notice)}</p>`);
      }
      if (page.error !== undefined) {
        lines.push(`<p role="alert">${escape(page.error)}</p>`);
      }
      lines.push(
        '<form method="post" action="/login">',
        entry('username', REBRANDED_WORDING.usernameLabel),
        entry('password', 'Password', 'password'),
        '<button class="action" type="submit">Sign in</button>',
        '</form>',
      );
      return lines.join('\n');
    }

    case 'search':
      return [
        '<h1>Find an account</h1>',
        '<form method="get" action="/account">',
        entry('ref', REBRANDED_WORDING.accountRefLabel),
        `<button class="action" type="submit">${escape(REBRANDED_WORDING.lookupButton)}</button>`,
        '</form>',
      ].join('\n');

    case 'account': {
      const lines = [
        '<h1>Account summary</h1>',
        '<dl class="facts">',
        `<dt>Account number</dt><dd data-testid="ref">${escape(page.account.ref)}</dd>`,
        `<dt>Account type</dt><dd data-testid="kind">${escape(page.account.kind)}</dd>`,
        `<dt>Account holder</dt><dd data-testid="owner">${escape(page.account.owner)}</dd>`,
      ];
      if (page.balanceOn === 'this-screen') {
        lines.push(
          `<dt>${escape(REBRANDED_WORDING.balanceTerm)}</dt><dd id="balance-value" data-testid="balance">${escape(formatAmount(page.account.balanceMinor))}</dd>`,
        );
      }
      lines.push('</dl>');
      if (page.balanceOn === 'next-screen') {
        lines.push(
          `<p><a href="/account/balances?ref=${escape(page.account.ref)}">Show balances</a></p>`,
        );
      }
      return lines.join('\n');
    }

    case 'account-balances':
      return [
        '<h1>Account balances</h1>',
        '<dl class="facts">',
        `<dt>Account number</dt><dd data-testid="ref">${escape(page.account.ref)}</dd>`,
        `<dt>${escape(REBRANDED_WORDING.balanceTerm)}</dt><dd id="balance-value" data-testid="balance">${escape(formatAmount(page.account.balanceMinor))}</dd>`,
        '</dl>',
      ].join('\n');

    case 'not-found':
      return [
        `<h1>${escape(REBRANDED_WORDING.notFoundHeading)}</h1>`,
        `<p role="alert">${escape(REBRANDED_WORDING.notFoundHeading)}: ${escape(page.ref)}</p>`,
        '<p><a href="/search">Find an account</a></p>',
      ].join('\n');

    case 'denied':
      return [
        `<h1>${escape(REBRANDED_WORDING.deniedHeading)}</h1>`,
        `<p role="alert">${escape(REBRANDED_WORDING.deniedHeading)} to ${escape(page.ref)}.</p>`,
        `<p>This account requires the ${escape(page.requiredRole)} role.</p>`,
      ].join('\n');

    case 'transfer': {
      const lines = ['<h1>New transfer</h1>'];
      if (page.error !== undefined) {
        lines.push(`<p role="alert">${escape(page.error)}</p>`);
      }
      lines.push(
        '<form method="post" action="/transfer">',
        moneyMoveFields(page.values),
        '<button class="action" type="submit">Review transfer</button>',
        '</form>',
      );
      return lines.join('\n');
    }

    case 'transfer-confirm':
      return [
        '<h1>Confirm transfer</h1>',
        '<dl class="facts">',
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
        '<button class="action" type="submit">Confirm transfer</button>',
        '</form>',
      ].join('\n');

    case 'transfer-done':
      return [
        '<h1>Transfer complete</h1>',
        `<p role="status">Transfer complete. Reference ${escape(page.reference)}.</p>`,
        '<dl class="facts">',
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

export function renderRebranded(model: PageModel): string {
  const greeting = 'user' in model.page ? `Signed in as ${model.page.user.displayName}` : undefined;

  const parts = [shell(inner(model.page), greeting)];
  if (model.dialog !== undefined) {
    parts.push(dialogOverlay(model.dialog, 'Dismiss'));
  }

  return document({ title: rebrandedTitle(model.page), style: STYLE, body: parts.join('\n') });
}
