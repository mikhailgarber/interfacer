import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FIXTURE_NAMES,
  startAll,
  type FixtureBundle,
  type FixtureName,
} from '@interfacer/fixtures';

/**
 * Each fixture can be asked to produce every exceptional condition on demand,
 * because a suite that can only reach the happy path cannot test the
 * verification order, the retry gating or the error taxonomy at all.
 */

let bundle: FixtureBundle;

beforeAll(async () => {
  bundle = await startAll();
});

afterAll(async () => {
  await bundle.closeAll();
});

function base(name: FixtureName): string {
  return bundle.fixtures[name].url;
}

async function signIn(name: FixtureName): Promise<string> {
  const response = await fetch(`${base(name)}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=teller1&password=s3cret-teller',
  });

  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe.each(FIXTURE_NAMES)('%s', (name) => {
  it('produces an application error on demand', async () => {
    const cookie = await signIn(name);
    const response = await fetch(`${base(name)}/search?_fx=app-error`, { headers: { cookie } });

    // A 500 with a page on it, which is what a real system does — and what
    // makes this distinguishable from the server having gone away.
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('could not be completed');
  });

  it('expires a session on demand', async () => {
    const cookie = await signIn(name);

    const expiring = await fetch(`${base(name)}/search?_fx=session-expired`, {
      redirect: 'manual',
      headers: { cookie },
    });

    expect(expiring.status).toBe(302);
    expect(expiring.headers.get('location')).toBe('/login?expired=1');

    // The session is genuinely gone server-side, not merely redirected once:
    // the same cookie no longer works on a later request.
    const after = await fetch(`${base(name)}/search`, { redirect: 'manual', headers: { cookie } });

    expect(after.status).toBe(302);
    expect(after.headers.get('location')).toBe('/login');
  });

  it('covers the content with an unexpected dialog on demand', async () => {
    const cookie = await signIn(name);
    const response = await fetch(`${base(name)}/account?ref=ACC-1001&_fx=dialog`, {
      headers: { cookie },
    });

    const html = await response.text();

    // A modal can hide both a checkpoint and an outcome banner, which is
    // precisely why the engine's verification order makes the page legible
    // before it judges either.
    expect(html).toContain('aria-modal="true"');
    // The account ref rather than the balance: `skewed` moves the balance to a
    // second screen, and this claim is about the dialog, not about the layout.
    expect(html).toContain('ACC-1001');
  });

  it('covers an outcome banner too, not just the happy path', async () => {
    const cookie = await signIn(name);
    const response = await fetch(`${base(name)}/account?ref=ACC-9999&_fx=dialog`, {
      headers: { cookie },
    });

    expect(await response.text()).toContain('aria-modal="true"');
  });

  it('carries a requested condition across a redirect', async () => {
    // Without this, asking for a dialog on a POST that redirects would lose the
    // request before reaching the screen that should show it — and the
    // multi-step flows are where an interstitial is worth testing.
    const login = await fetch(`${base(name)}/login?_fx=dialog`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=teller1&password=s3cret-teller',
    });

    expect(login.headers.get('location')).toBe('/sso/callback?_fx=dialog');
  });

  it('loads slowly but successfully on demand', async () => {
    const cookie = await signIn(name);
    const started = performance.now();
    const response = await fetch(`${base(name)}/account?ref=ACC-1001&_fx=slow&_ms=250`, {
      headers: { cookie },
    });
    const elapsed = performance.now() - started;

    // "Loaded slowly" and "never loaded" have to stay distinguishable, which is
    // the whole reason waiting is a predicate with a bound rather than a sleep.
    expect(response.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(await response.text()).toContain('ACC-1001');
  });

  it('ignores a condition it does not recognise', async () => {
    // The parameter is a test affordance; 400-ing on an unknown value would
    // turn a typo in a test into a confusing application failure.
    const cookie = await signIn(name);
    const response = await fetch(`${base(name)}/account?ref=ACC-1001&_fx=nonsense`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
  });

  it('answers a normal request with no delay at all', async () => {
    const cookie = await signIn(name);
    const started = performance.now();

    await fetch(`${base(name)}/account?ref=ACC-1001`, { headers: { cookie } });

    expect(performance.now() - started).toBeLessThan(200);
  });
});
