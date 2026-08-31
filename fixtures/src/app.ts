/**
 * The application every fixture serves.
 *
 * One application, five renderings. Routing, sessions and the state machine live
 * here; a variant decides only how a {@link PageModel} becomes HTML — with the
 * single exception of `skewed`, which splits the detail screen in two and so
 * genuinely routes differently. That exception is the point of `skewed`: a
 * structural difference is the one tenant difference the design says earns its
 * own artifact.
 */
import { requestedCondition, withCondition, type RequestedCondition } from './conditions.js';
import {
  findAccount,
  findUser,
  findUserByName,
  mayView,
  TRANSFER_REFERENCE,
  type User,
} from './data.js';
import { EMPTY_TRANSFER, type PageModel, type TransferValues } from './model.js';

export const SESSION_COOKIE = 'fx_session';

export interface AppRequest {
  readonly method: string;
  /** Path and query, as received. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export type AppResponse =
  | { readonly kind: 'page'; readonly status: number; readonly model: PageModel }
  | { readonly kind: 'redirect'; readonly location: string; readonly setCookie?: string }
  | { readonly kind: 'text'; readonly status: number; readonly body: string };

export interface AppResult {
  readonly response: AppResponse;
  /** How long the server should wait before answering. Zero for every normal request. */
  readonly delayMs: number;
}

export interface AppOptions {
  /** `skewed` shows identity and balances on two screens instead of one. */
  readonly splitDetail: boolean;
  /**
   * A URL on a **different host**, for the off-allowlist redirect.
   *
   * Different host, not merely a different port: the allowlist's unit is the
   * host and it ignores ports, so `127.0.0.1` and `localhost` are what make a
   * genuinely off-list navigation reachable without leaving the loopback
   * interface or depending on DNS.
   */
  readonly offsiteUrl: string;
}

/** Server-held sessions. In memory, one map per running fixture. */
export class Sessions {
  readonly #byId = new Map<string, string>();
  #next = 0;

  create(username: string): string {
    const id = `s${(this.#next++).toString(36)}-${username}`;
    this.#byId.set(id, username);
    return id;
  }

  user(id: string | undefined): User | undefined {
    if (id === undefined) {
      return undefined;
    }
    const username = this.#byId.get(id);
    return username === undefined ? undefined : findUserByName(username);
  }

  destroy(id: string | undefined): void {
    if (id !== undefined) {
      this.#byId.delete(id);
    }
  }
}

function page(model: PageModel, status = 200): AppResponse {
  return { kind: 'page', status, model };
}

function redirect(location: string, setCookie?: string): AppResponse {
  return setCookie === undefined
    ? { kind: 'redirect', location }
    : { kind: 'redirect', location, setCookie };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function formValue(body: string, name: string): string {
  return new URLSearchParams(body).get(name) ?? '';
}

function transferFrom(body: string): TransferValues {
  return {
    fromRef: formValue(body, 'fromRef'),
    toRef: formValue(body, 'toRef'),
    amount: formValue(body, 'amount'),
    memo: formValue(body, 'memo'),
  };
}

/** Applied to any screen the request asked to have covered by a modal. */
function withDialog(model: PageModel, requested: RequestedCondition): PageModel {
  return requested.condition === 'dialog'
    ? { ...model, dialog: 'Your session will be locked after 15 minutes of inactivity.' }
    : model;
}

export function handle(request: AppRequest, sessions: Sessions, options: AppOptions): AppResult {
  const url = new URL(request.url, 'http://fixture.invalid');
  const requested = requestedCondition(url);
  const delayMs = requested.condition === 'slow' ? requested.delayMs : 0;

  const response = route(request, url, requested, sessions, options);

  return { response, delayMs };
}

function route(
  request: AppRequest,
  url: URL,
  requested: RequestedCondition,
  sessions: Sessions,
  options: AppOptions,
): AppResponse {
  if (requested.condition === 'app-error') {
    // An unexpected application failure: a 500 with a page on it, which is what
    // a real system does and what makes this distinguishable from a crash.
    return page(
      { page: { screen: 'app-error', detail: 'The request could not be completed.' } },
      500,
    );
  }

  const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);

  if (requested.condition === 'session-expired') {
    // A session that was valid a moment ago no longer is. Dropped server-side
    // and bounced to the login screen, exactly as an idle timeout would.
    sessions.destroy(sessionId);
    return redirect(`/login?expired=1`);
  }

  const user = sessions.user(sessionId);
  const path = url.pathname;

  if (path === '/') {
    return redirect(withCondition(user === undefined ? '/login' : '/search', requested));
  }

  if (path === '/login') {
    return request.method === 'POST'
      ? signIn(request, requested, sessions)
      : page(
          withDialog(
            {
              page: {
                screen: 'login',
                ...(url.searchParams.has('expired')
                  ? { notice: 'Your session expired. Please sign in again.' }
                  : {}),
              },
            },
            requested,
          ),
        );
  }

  // A two-hop redirect chain on the way in, so resolving a chain — and checking
  // the allowlist on where it *lands* — is exercised by the ordinary path.
  if (path === '/sso/callback') {
    return redirect(withCondition('/search', requested));
  }

  if (path === '/logout') {
    sessions.destroy(sessionId);
    return redirect('/login');
  }

  if (path === '/offsite') {
    // Leaves the fixture's host entirely. Nothing links here from a normal
    // flow; it exists so a test can drive a navigation off the allowlist.
    return redirect(options.offsiteUrl);
  }

  if (user === undefined) {
    return redirect(withCondition('/login', requested));
  }

  return authenticated(request, url, path, requested, user, options);
}

function signIn(
  request: AppRequest,
  requested: RequestedCondition,
  sessions: Sessions,
): AppResponse {
  const username = formValue(request.body, 'username');
  const password = formValue(request.body, 'password');
  const user = findUser(username, password);

  if (user === undefined) {
    return page({ page: { screen: 'login', error: 'Sign in failed. Check your details.' } }, 401);
  }

  return redirect(
    withCondition('/sso/callback', requested),
    `${SESSION_COOKIE}=${sessions.create(user.username)}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function authenticated(
  request: AppRequest,
  url: URL,
  path: string,
  requested: RequestedCondition,
  user: User,
  options: AppOptions,
): AppResponse {
  if (path === '/search') {
    return page(withDialog({ page: { screen: 'search', user } }, requested));
  }

  if (path === '/account' || path === '/account/balances') {
    return accountScreen(url, path, requested, user, options);
  }

  if (path === '/transfer') {
    return request.method === 'POST'
      ? transferConfirm(request, requested, user)
      : page(withDialog({ page: { screen: 'transfer', user, values: EMPTY_TRANSFER } }, requested));
  }

  if (path === '/transfer/confirm' && request.method === 'POST') {
    // The point of no return. Everything before it is reversible; this is the
    // step a recorded flow marks with `.commit()`.
    const values = transferFrom(request.body);
    return page({
      page: { screen: 'transfer-done', user, values, reference: TRANSFER_REFERENCE },
    });
  }

  return { kind: 'text', status: 404, body: 'Not found' };
}

/**
 * The step before the point of no return.
 *
 * A separate confirmation screen exists so that a recorded flow has somewhere to
 * put an approval pause: the design requires approval to precede `.commit()`,
 * and that is only checkable if the two are distinct steps.
 */
function transferConfirm(
  request: AppRequest,
  requested: RequestedCondition,
  user: User,
): AppResponse {
  const values = transferFrom(request.body);

  const invalid =
    values.fromRef === '' || values.toRef === ''
      ? 'Both accounts are required.'
      : !/^\d+(\.\d{1,2})?$/.test(values.amount)
        ? 'Enter an amount, such as 25.00.'
        : undefined;

  if (invalid !== undefined) {
    return page(
      withDialog({ page: { screen: 'transfer', user, values, error: invalid } }, requested),
      400,
    );
  }

  return page(withDialog({ page: { screen: 'transfer-confirm', user, values } }, requested));
}

function accountScreen(
  url: URL,
  path: string,
  requested: RequestedCondition,
  user: User,
  options: AppOptions,
): AppResponse {
  const ref = url.searchParams.get('ref') ?? '';
  const account = findAccount(ref);

  if (account === undefined) {
    // A legitimate answer to the question the caller asked, not a crash — so it
    // is a 200 with a screen on it, the way a real application answers it.
    return page(withDialog({ page: { screen: 'not-found', user, ref } }, requested));
  }

  if (!mayView(user, account)) {
    return page(
      withDialog(
        { page: { screen: 'denied', user, ref, requiredRole: account.requiredRole } },
        requested,
      ),
      403,
    );
  }

  if (path === '/account/balances') {
    return options.splitDetail
      ? page(withDialog({ page: { screen: 'account-balances', user, account } }, requested))
      : { kind: 'text', status: 404, body: 'Not found' };
  }

  return page(
    withDialog(
      {
        page: {
          screen: 'account',
          user,
          account,
          balanceOn: options.splitDetail ? 'next-screen' : 'this-screen',
        },
      },
      requested,
    ),
  );
}
