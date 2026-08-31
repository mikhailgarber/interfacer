/**
 * The allowlist: which hosts the automation may visit.
 *
 * There are two lists with different sources and lifetimes. The discovery list
 * is proposed by the model from the task description and **confirmed by the
 * user**; it is wider, because the agent explores pages that will not survive
 * into the final flow, and it is the prompt-injection backstop — the agent reads
 * page content, page content can contain instructions, and this is what stops a
 * successful injection from becoming a navigation anywhere. The replay list is
 * computed from the recorded flow, is strictly tighter, and is a tripwire:
 * leaving it means the application changed.
 *
 * Both are checked the same way, and both are checked on the **resolved** URL
 * after redirects, since an allowed host can redirect off-list.
 */

/**
 * A concrete host, or a single leading `*.` wildcard standing for any
 * subdomain of one.
 *
 * `*.mybank.com` matches `auth.mybank.com` and `a.b.mybank.com`, and
 * deliberately does **not** match `mybank.com` itself — the apex must be listed
 * explicitly. The interview proposes concrete hosts and the user confirms them,
 * so a pattern quietly covering one more host than the user read is the failure
 * worth avoiding here.
 *
 * Ports are not part of a pattern. The design's unit is the host.
 */
export type HostPattern = string;

export type DenialReason =
  /** Not a URL at all. */
  | 'malformed-url'
  /** Not `http:` or `https:` — `file:`, `data:` and `javascript:` are never navigable. */
  | 'unsupported-scheme'
  /** A well-formed http(s) URL whose host is on no pattern. */
  | 'host-not-allowed';

export type AllowlistDecision =
  | {
      readonly allowed: true;
      readonly url: string;
      readonly host: string;
      /** Which pattern admitted it — evidence, and what makes a too-wide list findable. */
      readonly pattern: HostPattern;
    }
  | {
      readonly allowed: false;
      readonly url: string;
      readonly reason: DenialReason;
      readonly host?: string;
    };

/**
 * Reject a pattern that cannot have been what anybody confirmed.
 *
 * A bare `*`, or a wildcard with nothing after it, is a total bypass wearing the
 * shape of a guardrail. This throws rather than denying, because an allowlist is
 * authored data — a malformed entry is a defect in the artifact, not a condition
 * encountered at run time.
 */
function assertUsablePattern(pattern: HostPattern): void {
  const body = pattern.startsWith('*.') ? pattern.slice(2) : pattern;

  if (body.length === 0 || body.includes('*')) {
    throw new TypeError(
      `unusable allowlist pattern ${JSON.stringify(pattern)}: ` +
        'a pattern is a host, optionally prefixed with a single "*." for its subdomains',
    );
  }
}

function matchesPattern(host: string, pattern: HostPattern): boolean {
  const normalized = pattern.toLowerCase();

  if (normalized.startsWith('*.')) {
    const base = normalized.slice(2);
    // Anchored at a label boundary, so `*.example.com` admits `a.example.com`
    // but neither `example.com` nor `evil-example.com`.
    return host.endsWith(`.${base}`);
  }

  return host === normalized;
}

/**
 * Whether a resolved URL may be navigated to.
 *
 * Enforcement lives inside the DSL rather than around the process because the
 * decision is per navigation: a process-level network permission cannot tell a
 * legitimate page load from one an injection asked for.
 */
export function checkAllowlist(url: string, allowlist: readonly HostPattern[]): AllowlistDecision {
  for (const pattern of allowlist) {
    assertUsablePattern(pattern);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, url, reason: 'malformed-url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, url, reason: 'unsupported-scheme' };
  }

  // `URL` already lowercases the hostname; the trailing dot of a fully
  // qualified name is stripped so `mybank.com.` cannot slip past `mybank.com`.
  const host = parsed.hostname.replace(/\.$/, '');

  for (const pattern of allowlist) {
    if (matchesPattern(host, pattern)) {
      return { allowed: true, url, host, pattern };
    }
  }

  return { allowed: false, url, reason: 'host-not-allowed', host };
}
