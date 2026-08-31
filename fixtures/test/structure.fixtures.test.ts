import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REBRANDED_WORDING,
  startAll,
  type FixtureBundle,
  type FixtureName,
} from '@interfacer/fixtures';

import { structureOf } from './structure.js';

/**
 * The multi-tenant claim, made checkable.
 *
 * The design draws a line: branding and wording are absorbed by semantic
 * targeting and by accessible-name alternatives, while a *structural*
 * difference is the tenant difference that earns its own artifact. Both halves
 * of that line are asserted here — `rebranded` on one side of it, `skewed` on
 * the other.
 *
 * This is the cheap version of the claim. The real one is the Phase 3 test that
 * replays the same recorded flow against `rebranded` unchanged; this one runs
 * without a browser and localizes a break to a screen.
 */

let bundle: FixtureBundle;

beforeAll(async () => {
  bundle = await startAll();
});

afterAll(async () => {
  await bundle.closeAll();
});

async function signIn(name: FixtureName): Promise<string> {
  const response = await fetch(`${bundle.fixtures[name].url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=teller1&password=s3cret-teller',
  });

  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function fetchPage(name: FixtureName, path: string): Promise<string> {
  const cookie = path === '/login' ? '' : await signIn(name);

  return (await fetch(`${bundle.fixtures[name].url}${path}`, { headers: { cookie } })).text();
}

/** Every screen a flow can reach, so structure is compared across all of them. */
const SCREENS: readonly [label: string, path: string][] = [
  ['login', '/login'],
  ['search', '/search'],
  ['account detail', '/account?ref=ACC-1001'],
  ['account not found', '/account?ref=ACC-9999'],
  ['transfer form', '/transfer'],
];

describe('rebranded preserves clean structure', () => {
  it.each(SCREENS)('%s', async (_label, path) => {
    const [clean, rebranded] = await Promise.all([
      fetchPage('clean', path),
      fetchPage('rebranded', path),
    ]);

    // A rebrand may change colours, class names, chrome and wording. It may not
    // change the element tree, and a flow's targets depend only on the tree.
    expect(structureOf(rebranded)).toBe(structureOf(clean));
  });

  it('really did change the branding, so the comparison means something', () => {
    // Guards the guard: if the two fixtures rendered identical bytes, every
    // assertion above would pass while testing nothing.
    expect(REBRANDED_WORDING.brand).not.toContain('Meridian');
  });

  it.each(SCREENS)('renders different bytes for %s', async (_label, path) => {
    const [clean, rebranded] = await Promise.all([
      fetchPage('clean', path),
      fetchPage('rebranded', path),
    ]);

    expect(rebranded).not.toBe(clean);
  });

  it('rewords the accessible names a target chain has to admit alternatives for', async () => {
    const search = await fetchPage('rebranded', '/search');

    // The wording tier: one institution says "Member" where another says
    // "Customer". A flow survives this with an alternative in the target chain,
    // and nothing else about it changes.
    expect(search).toContain(REBRANDED_WORDING.accountRefLabel);
    expect(search).toContain(REBRANDED_WORDING.lookupButton);
    expect(search).not.toContain('Account number');
  });

  it('rewords an outcome banner, which is what a copied detector breaks on', async () => {
    const notFound = await fetchPage('rebranded', '/account?ref=ACC-9999');

    // The realistic multi-tenant failure is copying a sibling project and
    // pointing it at another institution: the detectors come along still
    // matching wording the new tenant does not use, and a business outcome
    // quietly degrades into a hard failure.
    expect(notFound).toContain(REBRANDED_WORDING.notFoundHeading);
    expect(notFound).not.toContain('No such account');
  });
});

describe('skewed diverges structurally', () => {
  it('does not preserve the detail screen', async () => {
    const [clean, skewed] = await Promise.all([
      fetchPage('clean', '/account?ref=ACC-1001'),
      fetchPage('skewed', '/account?ref=ACC-1001'),
    ]);

    // The one difference nothing absorbs. This is the fork line: the balance
    // moved to another screen, so a flow that read it here no longer can.
    expect(structureOf(skewed)).not.toBe(structureOf(clean));
  });

  it('leaves every other screen alone, so the divergence is localized', async () => {
    // `skewed` is `clean` with one screen split. If it differed everywhere it
    // would be a different application, and it would prove nothing about where
    // the fork line sits.
    for (const path of ['/login', '/search', '/transfer']) {
      const [clean, skewed] = await Promise.all([
        fetchPage('clean', path),
        fetchPage('skewed', path),
      ]);

      expect(structureOf(skewed), path).toBe(structureOf(clean));
    }
  });
});

describe('the hostile fixture is genuinely hostile', () => {
  it('announces a control differently from how it reads', async () => {
    const login = await fetchPage('hostile', '/login');

    // `byRole('button', 'Sign in')` finds nothing here while `byText('Sign in')`
    // works. A model shown a screenshot would get this wrong; a model shown the
    // accessibility tree gets it right, which is why the tree is what it sees.
    expect(login).toContain('aria-label="Submit credentials"');
    expect(login).toContain('>Sign in<');
  });

  it('labels two different fields the same', async () => {
    const search = await fetchPage('hostile', '/search');
    const labels = [...search.matchAll(/<label[^>]*>([^<]*)<\/label>/g)].map((match) => match[1]);

    // `byLabel('ID')` matches two elements, and the design's rule there is a
    // hard failure — never "take the first".
    expect(labels.filter((label) => label === 'ID')).toHaveLength(2);
  });

  it('offers only generated class names as CSS hooks on its chrome', async () => {
    const search = await fetchPage('hostile', '/search');

    // Present in the markup so the fixture has them; never recorded, because
    // the design excludes generated class names from a target chain outright.
    expect(search).toMatch(/class="css-[0-9a-f]{6}"/);
  });

  it('nests its layout tables three deep', async () => {
    const search = await fetchPage('hostile', '/search');
    const structure = structureOf(search);
    const deepest = Math.max(
      ...structure.split('\n').map((line) => (line.length - line.trimStart().length) / 2),
    );

    expect(deepest).toBeGreaterThanOrEqual(9);
  });

  it('puts content in a separate document, off the critical path', async () => {
    const search = await fetchPage('hostile', '/search');

    // A frame is present so the fixture is realistic, and nothing needed to
    // complete a flow lives inside it — so this does not force a frame
    // traversal decision the design does not make. See docs/testing.md.
    expect(search).toContain('<iframe');
  });

  it('offers no heading role to check a screen against', async () => {
    const account = await fetchPage('hostile', '/account?ref=ACC-1001');

    expect(account).not.toContain('<h1');
    expect(account).toContain('Account summary');
  });
});

describe('the legacy fixture degrades the way legacy software does', () => {
  it('associates no label with any field', async () => {
    const login = await fetchPage('legacy', '/login');

    // Field names sit in a table cell beside the input, so there is no
    // programmatic association and `byLabel` finds nothing.
    expect(login).not.toContain('<label');
    expect(login).toContain('Username');
  });

  it('still gives its submit buttons an accessible name', async () => {
    const login = await fetchPage('legacy', '/login');

    // A poor tree is still a tree: `<input type="submit">` takes its accessible
    // name from `value`, so `byRole` keeps working where `byLabel` cannot.
    expect(login).toContain('<input type="submit" value="Sign in">');
  });

  it('offers meaningful class names rather than generated ones', async () => {
    const account = await fetchPage('legacy', '/account?ref=ACC-1001');

    // This is what makes `legacy` exercise the chain falling through to `css`
    // without exercising the thing that is never recorded.
    expect(account).toContain('class="balance"');
    expect(account).not.toMatch(/class="css-[0-9a-f]{6}"/);
  });

  it('carries no test IDs', async () => {
    expect(await fetchPage('legacy', '/search')).not.toContain('data-testid');
  });
});

describe('the clean fixture is genuinely tractable', () => {
  it('offers a role, a label and a test ID for every field', async () => {
    const login = await fetchPage('clean', '/login');

    expect(login).toContain('<label for="username">Username</label>');
    expect(login).toContain('data-testid="username"');
    expect(login).toContain('<button type="submit">Sign in</button>');
  });

  it('offers a heading to check a screen against', async () => {
    expect(await fetchPage('clean', '/account?ref=ACC-1001')).toContain('<h1>Account summary</h1>');
  });
});
