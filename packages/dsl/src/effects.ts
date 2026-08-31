/**
 * `effects` — what a capability does, declared as a value.
 *
 * Every capability declares its effects. They are published in the contract so a
 * caller can see them before invoking, and each dimension drives a specific
 * enforcement rather than a vague risk score: enforcement keys off individual
 * dimensions, because a rolled-up score would lose the ability to say that
 * "read-only but touches everything" is fine.
 *
 * A value rather than a type, for the same reason `fields()` is: the CLI, the
 * MCP tool description and the generated documentation all have to read it at
 * run time, and a TypeScript `interface` is erased at compile time.
 *
 * This module is the declaration and the two pure functions `dataClasses` drives.
 * Enforcement of the other dimensions — approval before `.commit()`, attended
 * execution for a `securityEffect` — is Phase 6.
 */

/** Does it only read, or does it change something? */
export type Mutates = 'read' | 'write';

/** Can the change be undone, and how? `no` requires an approval before the commit. */
export type Reversible = 'yes' | 'compensable' | 'no';

/**
 * Whether the action changes **who can access the account afterwards**.
 *
 * It exists because the other dimensions score account takeover as low risk:
 * changing a password is `write`, `reversible` (change it back), and
 * single-step — and is the last move of taking over an account.
 */
export type SecurityEffect = 'none' | 'authority-change' | 'control-override';

/** How many records the action touches. Declared, not enforced — `bounded` needs a counter. */
export type Scope = 'single' | `bounded(${number})` | 'unbounded';

/**
 * Whether the action reaches beyond the application.
 *
 * Declared, not enforced: its enforcement would be identical to `reversible: no`.
 * The design names the dimension without enumerating it, so these are the two
 * cases it describes — notifying a customer, and reaching a third party.
 */
export type External = 'none' | 'notifies-customer' | 'third-party';

/** Declared, not enforced — the amount would be checked against the cap before the commit. */
export type Financial = 'none' | `moves-funds(${string})`;

/**
 * What kinds of data the automation observes.
 *
 * Declared for the **capability**, not per element, which is what makes the
 * evidence rules below a property of the artifact rather than a judgement made
 * fresh on every page.
 */
export type DataClass = 'non-identifying' | 'PII' | 'full-PAN' | 'SSN';

export interface Effects {
  readonly mutates: Mutates;
  readonly reversible: Reversible;
  readonly securityEffect: SecurityEffect;
  readonly scope: Scope;
  readonly external: External;
  readonly financial: Financial;
  /**
   * *If this ran twice by mistake, would that be a problem?* The caller-facing
   * question, and deliberately not what gates retry inside a run — `.commit()`
   * does that, per step.
   */
  readonly idempotent: boolean;
  readonly dataClasses: readonly DataClass[];
}

/**
 * What a capability that declares nothing is treated as.
 *
 * The interview always asks and generation always emits, so a real capability
 * never falls back to this — it is here for flows written by hand. It is the
 * permissive end deliberately: a conservative default would silently mask and
 * redact evidence for a capability nobody said handles anything sensitive, and
 * the reader would have no way to tell that from a declaration. Instead the
 * absence is *recorded*: `run.started` says whether the classes were declared or
 * defaulted, so it is visible rather than assumed.
 */
export const DEFAULT_EFFECTS: Effects = Object.freeze({
  mutates: 'read',
  reversible: 'yes',
  securityEffect: 'none',
  scope: 'single',
  external: 'none',
  financial: 'none',
  idempotent: true,
  dataClasses: Object.freeze(['non-identifying'] as const),
});

/**
 * What evidence a run is permitted to capture.
 *
 * Two requirements collide: evidence needs a rich signal on failure, and
 * regulated data must never be persisted into logs. A failure screenshot of a
 * back-office screen showing an account number and an SSN is precisely the
 * forbidden thing, and this is what arbitrates.
 */
export interface EvidencePolicy {
  readonly screenshot: 'full' | 'masked' | 'none';
  readonly dom: 'full' | 'structure-only';
  /**
   * `path-only` strips the query and fragment from every URL the record carries.
   *
   * A URL is observed page data like any other: this application puts an account
   * reference in a query string, so a value the run was given can reach the
   * record through a navigation entry without ever passing through a field. The
   * allowlist goes on being judged on the real URL — only the record is redacted.
   */
  readonly urls: 'full' | 'path-only';
}

/**
 * The strictest declared class wins.
 *
 * A capability declaring `['non-identifying', 'SSN']` observes an SSN, and the
 * balance it also reads does not make that less true.
 */
export function evidencePolicyFor(classes: readonly DataClass[]): EvidencePolicy {
  if (classes.includes('full-PAN') || classes.includes('SSN')) {
    // No pixels: structural evidence only. There is no mask that makes a
    // screenshot of a full card number safe to keep.
    return { screenshot: 'none', dom: 'structure-only', urls: 'path-only' };
  }

  if (classes.includes('PII')) {
    return { screenshot: 'masked', dom: 'structure-only', urls: 'path-only' };
  }

  return { screenshot: 'full', dom: 'full', urls: 'full' };
}

/**
 * Elements masked when the screenshot is `masked`.
 *
 * `dataClasses` is declared for the capability rather than for a node, so the
 * engine cannot know which element on a page is the sensitive one. What it can
 * do is distinguish the halves of a screen: these carry **values**, and what is
 * left — `label`, `th`, `dt`, headings, legends, button text — carries the
 * **names** of those values.
 *
 * Masking the value half and keeping the name half is what makes the design's
 * own justification true: "the balance field was present but empty" localizes a
 * fault as well as the figure would, and it only reads that way if you can still
 * see which field it was.
 */
export const VALUE_BEARING = 'input, textarea, select, output, td, dd, [data-testid]';

/** Attributes a structural DOM snapshot keeps: names, never values. */
export const STRUCTURAL_ATTRIBUTES: readonly string[] = Object.freeze([
  'id',
  'class',
  'name',
  'type',
  'role',
  'aria-label',
  'aria-labelledby',
  'data-testid',
  'for',
]);

/**
 * Strip a URL to origin and path.
 *
 * Query and fragment go because that is where an application puts the values it
 * was given — `/account?ref=ACC-1001` carries a reference the caller supplied.
 * The origin and path stay because a navigation nobody can locate is not
 * evidence.
 */
export function redactUrl(url: string, policy: EvidencePolicy): string {
  if (policy.urls === 'full') {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all. Anything unparseable that carries a query is not
    // something to hand on in the hope that it is safe.
    return url.includes('?') || url.includes('#') ? '[redacted]' : url;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // An opaque scheme — `about:blank` and the like. These parse, but `origin`
    // is the string "null" and `pathname` is not a path, so reconstructing one
    // produces nonsense ("nullblank") rather than a redaction. They carry no
    // page data anyway; the only thing to guard is a query.
    return parsed.search === '' && parsed.hash === '' ? url : '[redacted]';
  }

  const stripped = parsed.search === '' && parsed.hash === '' ? '' : '?[redacted]';
  return `${parsed.origin}${parsed.pathname}${stripped}`;
}
