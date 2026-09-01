/**
 * Walking a flow's own steps again, appending nothing.
 *
 * The one primitive two parts of generation share. Provoking an outcome needs
 * the application brought back to the state a different live value produces;
 * verifying a seed needs to know which of a copied flow's steps still resolve
 * against another tenant. Both are the same act: perform what the flow already
 * holds, and stop where the application refuses.
 *
 * It is the *engine* performing them — the same step cycle replay uses — so
 * "these steps still work here" means what it says.
 */
import {
  isReplayError,
  type Execution,
  type FieldSet,
  type Flow,
  type Step,
} from '@interfacer/dsl';

export interface Rerun {
  /** The steps that resolved, in order. */
  readonly kept: readonly Step[];
  /** The step the application refused, where one did. */
  readonly stoppedAt?: Step;
  /** Why it stopped: what the engine expected against what it observed. */
  readonly why?: string;
  /** A declared outcome matched, so the engine terminated there. */
  readonly outcomeMatched: boolean;
}

export async function rerunFlow(
  execution: Execution,
  flow: Flow<FieldSet, unknown>,
): Promise<Rerun> {
  const kept: Step[] = [];

  for (const step of flow.steps) {
    try {
      const reached = await execution.perform(step);
      if (reached !== undefined) {
        return { kept, stoppedAt: step, outcomeMatched: true };
      }
      kept.push(step);
    } catch (error) {
      if (isReplayError(error)) {
        return {
          kept,
          stoppedAt: step,
          why: `${error.expected} — observed ${error.observed}`,
          outcomeMatched: false,
        };
      }
      throw error;
    }
  }

  return { kept, outcomeMatched: false };
}
