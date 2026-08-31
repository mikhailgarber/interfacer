/**
 * What a fixture decides to show, before any variant decides how to show it.
 *
 * The five fixtures are one application rendered five ways. Splitting the
 * decision from the rendering is what makes two of the design's claims
 * checkable rather than asserted: `rebranded` can be proved to preserve
 * `clean`'s structure because both are showing the same model, and `skewed` can
 * be proved to diverge because it shows a different one.
 */
import type { Account, Role, User } from './data.js';

export interface TransferValues {
  readonly fromRef: string;
  readonly toRef: string;
  readonly amount: string;
  readonly memo: string;
}

export const EMPTY_TRANSFER: TransferValues = Object.freeze({
  fromRef: '',
  toRef: '',
  amount: '',
  memo: '',
});

export type Screen =
  | { readonly screen: 'login'; readonly error?: string; readonly notice?: string }
  | { readonly screen: 'search'; readonly user: User; readonly notice?: string }
  /** The whole detail screen, or — on `skewed` — only its identity half. */
  | {
      readonly screen: 'account';
      readonly user: User;
      readonly account: Account;
      /** `skewed` moves the balance to a second screen and links to it. */
      readonly balanceOn: 'this-screen' | 'next-screen';
    }
  /** `skewed` only: the second half of the split detail screen. */
  | { readonly screen: 'account-balances'; readonly user: User; readonly account: Account }
  | { readonly screen: 'not-found'; readonly user: User; readonly ref: string }
  | {
      readonly screen: 'denied';
      readonly user: User;
      readonly ref: string;
      readonly requiredRole: Role;
    }
  | {
      readonly screen: 'transfer';
      readonly user: User;
      readonly values: TransferValues;
      readonly error?: string;
    }
  | { readonly screen: 'transfer-confirm'; readonly user: User; readonly values: TransferValues }
  | {
      readonly screen: 'transfer-done';
      readonly user: User;
      readonly values: TransferValues;
      readonly reference: string;
    }
  | { readonly screen: 'app-error'; readonly detail: string };

export interface PageModel {
  readonly page: Screen;
  /**
   * An unexpected dialog, covering the content.
   *
   * It is modelled as a property of the page rather than a screen of its own
   * because that is what it is on a real application: an overlay that can hide
   * both a checkpoint and an outcome banner, which is precisely why the
   * engine's verification order puts recovery before either is judged.
   */
  readonly dialog?: string;
}

/** A screen's title, shared by every variant so wording differences stay deliberate. */
export function titleOf(page: Screen): string {
  switch (page.screen) {
    case 'login':
      return 'Sign in';
    case 'search':
      return 'Find an account';
    case 'account':
      return 'Account summary';
    case 'account-balances':
      return 'Account balances';
    case 'not-found':
      return 'No such account';
    case 'denied':
      return 'Not authorized';
    case 'transfer':
      return 'New transfer';
    case 'transfer-confirm':
      return 'Confirm transfer';
    case 'transfer-done':
      return 'Transfer complete';
    case 'app-error':
      return 'Application error';
  }
}

/** The signed-in user, where there is one. */
export function userOf(page: Screen): User | undefined {
  return 'user' in page ? page.user : undefined;
}
