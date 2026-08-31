/** Escaping and document shell, shared by every renderer. */

export function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface DocumentOptions {
  readonly title: string;
  readonly style: string;
  readonly body: string;
}

/**
 * Every fixture page, byte for byte.
 *
 * Note what is absent: no timestamp, no nonce, no CSRF token, no cache-buster.
 * The same request has to render the same bytes, or "replay one flow N times
 * and assert the same steps" is testing the fixture's entropy rather than the
 * engine's determinism.
 */
export function document({ title, style, body }: DocumentOptions): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(title)}</title>`,
    `<style>${style}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The unexpected-dialog overlay.
 *
 * Rendered last and positioned over the content, so it covers whatever a
 * checkpoint or an outcome detector would be looking for. That is the whole
 * point of it: it is why the engine's verification order has to make the page
 * legible before it judges either.
 */
export function dialogOverlay(message: string, dismissLabel: string): string {
  return [
    '<div role="dialog" aria-modal="true" aria-label="Notice" class="fx-dialog">',
    '  <div class="fx-dialog-panel">',
    `    <p>${escape(message)}</p>`,
    `    <button type="button" onclick="this.closest('.fx-dialog').remove()">${escape(dismissLabel)}</button>`,
    '  </div>',
    '</div>',
  ].join('\n');
}

export const DIALOG_STYLE =
  '.fx-dialog{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;' +
  'align-items:center;justify-content:center;z-index:99}' +
  '.fx-dialog-panel{background:#fff;color:#000;padding:24px;max-width:28rem;border-radius:6px}';
