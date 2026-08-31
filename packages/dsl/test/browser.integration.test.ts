import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Phase 0 scaffold for the integration tier. It proves the browser toolchain is
 * actually installed and drivable on this machine — the thing most likely to be
 * broken on a fresh checkout or a new CI runner, and the thing every later
 * integration test silently assumes.
 *
 * Phase 3 replaces this with tests that author a `Flow` by hand and call
 * `.run()`. Note that this file is the last one allowed to touch a Playwright
 * `Page` directly: from Phase 3 on, integration tests drive the engine, never
 * Playwright, or the suite ends up testing Playwright's behaviour instead of the
 * verification order, retry gating, allowlist enforcement and record emission
 * that only happen inside the engine's step cycle.
 */
describe('browser toolchain', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('resolves a control through the accessibility tree', async () => {
    const page = await browser.newPage();
    await page.setContent('<main><h1>Account summary</h1></main>');

    // `getByRole` is the strategy the `Target` chain leads with, so this is the
    // narrowest useful check: the browser launches, and the accessibility tree
    // the design's targeting and its model observations both read from is
    // populated.
    const heading = page.getByRole('heading', { name: 'Account summary' });

    expect(await heading.count()).toBe(1);
    expect(await heading.textContent()).toBe('Account summary');
  });
});
