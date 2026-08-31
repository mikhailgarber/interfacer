/**
 * The fixtures' data, fixed.
 *
 * Nothing here is generated, randomized or derived from the clock, because
 * replay determinism cannot be tested against a moving target: a test that
 * replays a flow N times and asserts the same result needs the application to
 * give the same answer each time.
 */

export type Role = 'TELLER' | 'VIEWER';

export interface User {
  readonly username: string;
  readonly password: string;
  readonly displayName: string;
  readonly role: Role;
}

export interface Account {
  readonly ref: string;
  readonly kind: string;
  readonly owner: string;
  /** Minor units, so no floating-point money reaches a rendered page. */
  readonly balanceMinor: number;
  /** Viewing this account needs at least this role. */
  readonly requiredRole: Role;
}

export const USERS: readonly User[] = Object.freeze([
  Object.freeze({
    username: 'teller1',
    password: 's3cret-teller',
    displayName: 'Dana Teller',
    role: 'TELLER' as const,
  }),
  Object.freeze({
    username: 'viewer1',
    password: 's3cret-viewer',
    displayName: 'Robin Viewer',
    role: 'VIEWER' as const,
  }),
]);

export const ACCOUNTS: readonly Account[] = Object.freeze([
  Object.freeze({
    ref: 'ACC-1001',
    kind: 'Checking',
    owner: 'Dana Teller',
    balanceMinor: 125_075,
    requiredRole: 'VIEWER' as const,
  }),
  Object.freeze({
    ref: 'ACC-1002',
    kind: 'Savings',
    owner: 'Dana Teller',
    balanceMinor: 4_200_000,
    requiredRole: 'VIEWER' as const,
  }),
  /** Exists, but a VIEWER may not see it — the permission-denied outcome. */
  Object.freeze({
    ref: 'ACC-2002',
    kind: 'Escrow',
    owner: 'Held in trust',
    balanceMinor: 990_000,
    requiredRole: 'TELLER' as const,
  }),
]);

/** A reference that resolves to nothing — the record-not-found outcome. */
export const MISSING_ACCOUNT_REF = 'ACC-9999';

export function findUser(username: string, password: string): User | undefined {
  return USERS.find((user) => user.username === username && user.password === password);
}

export function findUserByName(username: string): User | undefined {
  return USERS.find((user) => user.username === username);
}

export function findAccount(ref: string): Account | undefined {
  return ACCOUNTS.find((account) => account.ref === ref);
}

export function mayView(user: User, account: Account): boolean {
  return account.requiredRole === 'VIEWER' || user.role === 'TELLER';
}

/**
 * `$1,250.75`.
 *
 * Formatted by hand rather than with `Intl.NumberFormat`, whose output depends
 * on the ICU data built into the running Node — which would make the same
 * request render different bytes on a different machine.
 */
export function formatAmount(minor: number): string {
  const negative = minor < 0;
  const absolute = Math.abs(minor);
  const units = Math.floor(absolute / 100).toString();
  const cents = (absolute % 100).toString().padStart(2, '0');

  const grouped = units.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '-' : ''}$${grouped}.${cents}`;
}

/** The reference a completed transfer is given. Fixed, for the same reason. */
export const TRANSFER_REFERENCE = 'TRF-000417';
