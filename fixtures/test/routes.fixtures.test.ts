import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FIXTURE_NAMES,
  MISSING_ACCOUNT_REF,
  startAll,
  type FixtureBundle,
  type FixtureName,
} from '@interfacer/fixtures';

/**
 * The fixtures tier: real HTTP, no engine, no browser.
 *
 * Every fixture is one application rendered differently, so every route claim
 * here is asserted against all five — if one variant's routing drifts, the
 * fixture stops being a variant and becomes a different application.
 *
 * Servers take ephemeral ports and are started per test file, so files running
 * in parallel workers cannot collide on a port or share a session store.
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

/** Sign in and return the session cookie, following the redirect chain by hand. */
async function signIn(name: FixtureName, username: string, password: string): Promise<string> {
  const response = await fetch(`${base(name)}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });

  const cookie = response.headers.get('set-cookie');
  if (cookie === null) {
    throw new Error(`${name}: sign-in did not set a session cookie`);
  }

  return cookie.split(';')[0] ?? '';
}

describe.each(FIXTURE_NAMES)('%s', (name) => {
  describe('signing in', () => {
    it('serves a login screen to an anonymous visitor', async () => {
      const response = await fetch(`${base(name)}/`, { redirect: 'manual' });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/login');
    });

    it('refuses a wrong password without a session', async () => {
      const response = await fetch(`${base(name)}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=teller1&password=wrong',
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('resolves a two-hop redirect chain on the way in', async () => {
      // The engine checks the allowlist on the URL a navigation *resolves* to,
      // so the ordinary path through this application is a chain rather than a
      // single hop.
      const login = await fetch(`${base(name)}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=teller1&password=s3cret-teller',
      });

      expect(login.status).toBe(302);
      expect(login.headers.get('location')).toBe('/sso/callback');

      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const hop = await fetch(`${base(name)}/sso/callback`, {
        redirect: 'manual',
        headers: { cookie },
      });

      expect(hop.status).toBe(302);
      expect(hop.headers.get('location')).toBe('/search');
    });

    it('sends an anonymous visitor back to the login screen', async () => {
      const response = await fetch(`${base(name)}/search`, { redirect: 'manual' });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/login');
    });
  });

  describe('looking an account up', () => {
    it('shows an account a teller may see', async () => {
      const cookie = await signIn(name, 'teller1', 's3cret-teller');
      const response = await fetch(`${base(name)}/account?ref=ACC-1001`, { headers: { cookie } });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('ACC-1001');
    });

    it('answers a missing account with a screen, not an error', async () => {
      const cookie = await signIn(name, 'teller1', 's3cret-teller');
      const response = await fetch(`${base(name)}/account?ref=${MISSING_ACCOUNT_REF}`, {
        headers: { cookie },
      });

      // A legitimate answer to the question the caller asked. The status is 200
      // because the application succeeded — it found out something true.
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(MISSING_ACCOUNT_REF);
    });

    it('refuses an account the role does not reach', async () => {
      const cookie = await signIn(name, 'viewer1', 's3cret-viewer');
      const response = await fetch(`${base(name)}/account?ref=ACC-2002`, { headers: { cookie } });

      expect(response.status).toBe(403);
      expect(await response.text()).toContain('TELLER');
    });

    it('shows the same account to a teller', async () => {
      const cookie = await signIn(name, 'teller1', 's3cret-teller');
      const response = await fetch(`${base(name)}/account?ref=ACC-2002`, { headers: { cookie } });

      expect(response.status).toBe(200);
    });
  });

  describe('the multi-field action', () => {
    it('reaches a confirmation screen before committing', async () => {
      const cookie = await signIn(name, 'teller1', 's3cret-teller');
      const response = await fetch(`${base(name)}/transfer`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          fromRef: 'ACC-1001',
          toRef: 'ACC-1002',
          amount: '25.00',
          memo: 'rent',
        }).toString(),
      });

      // Confirmation is a screen of its own so that an approval pause has
      // somewhere to sit: the design requires approval to precede `.commit()`,
      // which is only checkable if they are distinct steps.
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('ACC-1002');
      expect(html).toContain('25.00');
    });

    it('rejects an amount it cannot parse, without confirming', async () => {
      const cookie = await signIn(name, 'teller1', 's3cret-teller');
      const response = await fetch(`${base(name)}/transfer`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'fromRef=ACC-1001&toRef=ACC-1002&amount=lots&memo=',
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Enter an amount');
    });

    it('completes and reports a fixed reference', async () => {
      const cookie = await signIn(name, 'teller1', 's3cret-teller');
      const response = await fetch(`${base(name)}/transfer/confirm`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'fromRef=ACC-1001&toRef=ACC-1002&amount=25.00&memo=rent',
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('TRF-000417');
    });
  });

  describe('leaving the host', () => {
    it('redirects to a genuinely different host', async () => {
      const response = await fetch(`${base(name)}/offsite`, { redirect: 'manual' });
      const location = response.headers.get('location') ?? '';

      expect(response.status).toBe(302);

      // Different host, not merely a different port: the allowlist's unit is
      // the host and it ignores ports, so this is what makes an off-list
      // navigation reachable without leaving loopback or depending on DNS.
      expect(new URL(location).hostname).toBe('localhost');
      expect(new URL(base(name)).hostname).toBe('127.0.0.1');
      expect(new URL(location).hostname).not.toBe(new URL(base(name)).hostname);
    });

    it('serves something at the offsite host, so the navigation completes', async () => {
      const response = await fetch(`${bundle.offsite.url}/collect`);

      expect(response.status).toBe(200);
    });
  });

  describe('determinism', () => {
    it('renders identical bytes for an identical request', async () => {
      // Replay determinism cannot be tested against a moving target. No
      // timestamp, no nonce, no CSRF token, no cache-buster reaches a page.
      const cookie = await signIn(name, 'teller1', 's3cret-teller');
      const fetchOnce = async (): Promise<string> =>
        (await fetch(`${base(name)}/account?ref=ACC-1001`, { headers: { cookie } })).text();

      expect(await fetchOnce()).toBe(await fetchOnce());
    });

    it('renders identical bytes across two separate sessions', async () => {
      // Stronger: the session id differs between these two, so this also
      // asserts that nothing session-derived leaks into the body.
      const first = await signIn(name, 'teller1', 's3cret-teller');
      const second = await signIn(name, 'teller1', 's3cret-teller');

      expect(first).not.toBe(second);

      const read = async (cookie: string): Promise<string> =>
        (await fetch(`${base(name)}/account?ref=ACC-1001`, { headers: { cookie } })).text();

      expect(await read(first)).toBe(await read(second));
    });
  });
});

describe('skewed', () => {
  it('splits the detail screen in two', async () => {
    const cookie = await signIn('skewed', 'teller1', 's3cret-teller');

    const summary = await fetch(`${base('skewed')}/account?ref=ACC-1001`, { headers: { cookie } });
    const summaryHtml = await summary.text();

    // The balance is not on the screen a flow recorded against `clean` would
    // read it from. This is the structural divergence that earns its own
    // artifact rather than being absorbed by targeting.
    expect(summaryHtml).not.toContain('$1,250.75');
    expect(summaryHtml).toContain('/account/balances?ref=ACC-1001');

    const balances = await fetch(`${base('skewed')}/account/balances?ref=ACC-1001`, {
      headers: { cookie },
    });

    expect(balances.status).toBe(200);
    expect(await balances.text()).toContain('$1,250.75');
  });
});

describe.each(['clean', 'legacy', 'hostile', 'rebranded'] as const)('%s', (name) => {
  it('keeps the balance on the detail screen', async () => {
    const cookie = await signIn(name, 'teller1', 's3cret-teller');
    const response = await fetch(`${base(name)}/account?ref=ACC-1001`, { headers: { cookie } });

    expect(await response.text()).toContain('$1,250.75');
  });

  it('has no second balances screen to split onto', async () => {
    const cookie = await signIn(name, 'teller1', 's3cret-teller');
    const response = await fetch(`${base(name)}/account/balances?ref=ACC-1001`, {
      headers: { cookie },
    });

    expect(response.status).toBe(404);
  });
});
