/**
 * The fixture applications.
 *
 * Five real HTTP apps, differing in how hostile they are, because a single clean
 * app would never exercise the targeting chain. Not a public site — that removes
 * terms-of-service questions, rate limits and somebody else's outage from the
 * suite — and not a stubbed page object, because the rules the engine implements
 * are about navigation, resolved URLs after redirect, session expiry and
 * multi-page flow, none of which exist without a server.
 *
 * Each serves a login, a search, a detail screen and a multi-field action with a
 * confirmation step, and each can be asked to produce every exceptional
 * condition on demand. The data is fixed and the behaviour does not depend on
 * the clock, because replay determinism cannot be tested against a moving
 * target.
 *
 * `npm run fixtures` starts them all for a person to look at.
 */

export {
  ACCOUNTS,
  findAccount,
  findUser,
  findUserByName,
  formatAmount,
  mayView,
  MISSING_ACCOUNT_REF,
  TRANSFER_REFERENCE,
  USERS,
  type Account,
  type Role,
  type User,
} from './data.js';

export {
  CONDITION_PARAM,
  DEFAULT_DELAY_MS,
  DELAY_PARAM,
  MAX_DELAY_MS,
  requestedCondition,
  type Condition,
  type RequestedCondition,
} from './conditions.js';

export { SESSION_COOKIE } from './app.js';

export {
  EMPTY_TRANSFER,
  titleOf,
  userOf,
  type PageModel,
  type Screen,
  type TransferValues,
} from './model.js';

export { REBRANDED_WORDING } from './render/rebranded.js';

export {
  FIXTURE_HOST,
  FIXTURE_NAMES,
  OFFSITE_HOST,
  startAll,
  startFixture,
  startOffsite,
  VARIANTS,
  type FixtureBundle,
  type FixtureHandle,
  type FixtureName,
  type Renderer,
  type StartOptions,
  type Variant,
} from './server.js';
