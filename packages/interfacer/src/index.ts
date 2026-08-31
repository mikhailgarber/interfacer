/**
 * `interfacer` — the tool that runs discovery and writes capability projects.
 *
 * It depends on `@interfacer/dsl` as an ordinary consumer, on the same terms as
 * the projects it writes, and it is the only component that owns the Claude SDK.
 *
 * Phase 0 is scaffolding. The real surface arrives in:
 *
 * - **Phase 7** — the project generator.
 * - **Phase 8** — the agent loop and the single `decide(state, tools)` SDK seam.
 * - **Phase 9** — interview mode and the CLI's location resolution.
 * - **Phase 10** — generation mode and seeded discovery.
 */
import { STRATEGY_PREFERENCE } from '@interfacer/dsl';

export const packageName = 'interfacer';

/**
 * Re-exported so the scaffold can prove the dependency edge resolves at run time
 * as well as at compile time.
 *
 * Not arbitrary: Phase 8 has to show the model targets best-first, because the
 * observation format decides the locator quality. This is the order it will use.
 */
export const targetStrategyPreference = STRATEGY_PREFERENCE;
