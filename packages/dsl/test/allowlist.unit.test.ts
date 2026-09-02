import { describe, expect, it } from 'vitest';

import { checkAllowlist } from '@interfacer/dsl';

/**
 * The allowlist is a guardrail on a non-deterministic model during discovery and
 * a tripwire during replay. Its one job is to be checked on the URL the browser
 * actually landed on, so most of what is worth testing here is the ways a host
 * can look like it is on the list without being on it.
 */

const ALLOWLIST = ['mybank.com', '*.mybank.com', 'sso.identity.example'];

// @covers allowlist.host-patterns
describe('checkAllowlist', () => {
  describe('admits', () => {
    it.each([
      ['the apex, listed explicitly', 'https://mybank.com/login', 'mybank.com'],
      ['a subdomain via a wildcard', 'https://auth.mybank.com/login', '*.mybank.com'],
      ['a deep subdomain', 'https://a.b.mybank.com/', '*.mybank.com'],
      [
        'a third-party identity provider',
        'https://sso.identity.example/saml',
        'sso.identity.example',
      ],
      ['a host regardless of port', 'https://mybank.com:8443/login', 'mybank.com'],
      ['plain http', 'http://mybank.com/', 'mybank.com'],
      ['an uppercase host', 'https://MyBank.COM/login', 'mybank.com'],
    ])('%s', (_name, url, pattern) => {
      const decision = checkAllowlist(url, ALLOWLIST);

      expect(decision.allowed).toBe(true);
      // Which pattern admitted it is evidence: it is what makes a too-wide list
      // findable after the fact.
      expect(decision.allowed && decision.pattern).toBe(pattern);
    });
  });

  describe('refuses', () => {
    it.each([
      ['an unrelated host', 'https://evil.example/', 'host-not-allowed'],
      // The classic near-miss: a suffix match that is not a label boundary.
      ['a suffix that is not a label boundary', 'https://evil-mybank.com/', 'host-not-allowed'],
      [
        'a lookalike that appends the domain',
        'https://mybank.com.evil.example/',
        'host-not-allowed',
      ],
      ['a domain the wildcard sits under, not over', 'https://mybank.com.co/', 'host-not-allowed'],
      // A fully qualified name with a trailing dot resolves to the same host, so
      // it must not be a way past a pattern that lacks one.
      [
        'a subdomain of an unlisted parent',
        'https://mybank.com.attacker.test/',
        'host-not-allowed',
      ],
      ['a scheme that is not navigable', 'file:///etc/passwd', 'unsupported-scheme'],
      ['a data URL', 'data:text/html,<h1>hi</h1>', 'unsupported-scheme'],
      ['a javascript URL', 'javascript:alert(1)', 'unsupported-scheme'],
      ['something that is not a URL', 'not a url', 'malformed-url'],
      ['an empty string', '', 'malformed-url'],
    ])('%s', (_name, url, reason) => {
      const decision = checkAllowlist(url, ALLOWLIST);

      expect(decision.allowed).toBe(false);
      expect(!decision.allowed && decision.reason).toBe(reason);
    });

    it('a trailing-dot form of an allowed host is normalized, not refused', () => {
      // `mybank.com.` and `mybank.com` are the same host, so normalizing is
      // correct — the point is that it is normalized deliberately rather than
      // slipping past as an unrecognized string.
      expect(checkAllowlist('https://mybank.com./login', ALLOWLIST).allowed).toBe(true);
    });

    it('the apex, when only the wildcard is listed', () => {
      // `*.mybank.com` deliberately does not cover `mybank.com`. The interview
      // proposes concrete hosts and the user confirms them, so a pattern quietly
      // covering one more host than was read is the failure worth avoiding.
      const decision = checkAllowlist('https://mybank.com/', ['*.mybank.com']);

      expect(decision.allowed).toBe(false);
    });

    it('everything, when the list is empty', () => {
      expect(checkAllowlist('https://mybank.com/', []).allowed).toBe(false);
    });
  });

  describe('checks the resolved URL', () => {
    it('judges the redirect target, not the origin that redirected', () => {
      // An allowed host can redirect off-list, which is exactly the case a
      // check on the requested URL would miss.
      const landedOn = 'https://tracker.example/collect?from=mybank.com';

      expect(checkAllowlist(landedOn, ALLOWLIST).allowed).toBe(false);
    });

    it('reports the host it judged, so a denial says what was reached', () => {
      const decision = checkAllowlist('https://tracker.example/collect', ALLOWLIST);

      expect(decision.allowed).toBe(false);
      expect(!decision.allowed && decision.host).toBe('tracker.example');
    });
  });

  describe('refuses to accept a pattern nobody could have confirmed', () => {
    it.each([
      ['a bare wildcard', '*'],
      ['a wildcard with no base', '*.'],
      ['an interior wildcard', 'auth.*.mybank.com'],
      ['a trailing wildcard', 'mybank.*'],
      ['an empty pattern', ''],
      // Silently inert rather than malformed-looking: a pattern is matched
      // against `URL.hostname`, which never carries a port or a scheme, so
      // these can never match anything. A live run declared `127.0.0.1:4001`
      // and ran with an allowlist entry that admitted nothing — masked only
      // because the entry point's own origin is allowed independently.
      ['a host with a port', '127.0.0.1:4001'],
      ['a named host with a port', 'auth.mybank.com:8443'],
      ['a whole URL', 'https://mybank.com'],
      ['a host with a path', 'mybank.com/login'],
    ])('throws on %s', (_name, pattern) => {
      // A malformed pattern is a defect in the artifact, not a condition met at
      // run time — so it fails loudly rather than quietly denying (or worse,
      // quietly admitting) every navigation.
      expect(() => checkAllowlist('https://mybank.com/', [pattern])).toThrow(TypeError);
    });

    it('throws even when an earlier pattern would have admitted the URL', () => {
      expect(() => checkAllowlist('https://mybank.com/', ['mybank.com', '*'])).toThrow(TypeError);
    });
  });
});
