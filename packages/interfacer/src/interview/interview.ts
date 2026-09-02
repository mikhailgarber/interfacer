/**
 * Interview mode: the stage of a session that establishes the contract.
 *
 * A run is one continuous session with a human in it. The interview is its
 * first stage — an LLM-conducted conversation that turns a described task into
 * inputs, outcomes, interactions, effects and guardrails — and when everything
 * is settled the same session switches to generation mode, which discovers the
 * flow against the live application. Nothing is written between the two.
 *
 * The non-interactive path is the degenerate case rather than the normal one.
 * `--interview <path>` supplies the answers as prose and takes the human out of
 * the session, so there is nobody to ask and nobody to confirm: an insufficient
 * file exits listing what is missing, and the file itself is the authorization
 * record for the two guardrails Interfacer proposes.
 */
import { addUsage, ratesFor, spendCost, ZERO_SPEND, type Spend } from '@interfacer/dsl';

import { accepted, type Ask } from '../ask.js';
import {
  DEFAULT_MODEL,
  NO_CALL,
  type Converse,
  type Exchange,
  type ToolResult,
} from '../agent/decide.js';
import { ToolArgumentError } from '../agent/tools.js';
import { applyAnswers, type Authorization } from './answers.js';
import { gaps, settle, type Contract, type ContractDraft, type Gap } from './contract.js';
import { INTERVIEW_TOOL_NAMES, INTERVIEW_TOOLS, patchOf, proposalOf } from './tools.js';

/**
 * How many turns may pass without the draft moving or a human being reached.
 *
 * The same reasoning as the discovery loop's stall guard: a conversation going
 * nowhere should not spend the rest of the ceiling proving it.
 */
const DEFAULT_STALL_TURNS = 3;

const DEFAULT_MAX_TURNS = 40;

export interface InterviewOptions {
  readonly converse: Converse;
  /**
   * The human channel. Its absence is what makes a run non-interactive: there
   * is nobody to ask and nobody to confirm a proposal.
   */
  readonly ask?: Ask;
  /** Pre-answered interview prose. The authorization record where one is used. */
  readonly file?: string;
  /** Answers to start from — a project's declarations, or a proposal or two. */
  readonly seed?: ContractDraft;
  /**
   * Whether that seed is an existing project's own declarations.
   *
   * Separate from the seed itself because a *new* project also starts with
   * something in the draft — the capability id its directory name proposes —
   * and telling the model that is a rerun would have it ask about a delta from
   * a project that does not exist.
   */
  readonly rerun?: boolean;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly stallTurns?: number;
}

export type InterviewEnding = 'settled' | 'incomplete' | 'budget-exhausted' | 'turn-limit';

export interface InterviewResult {
  readonly ending: InterviewEnding;
  /** The settled contract. Absent unless the ending is `settled`. */
  readonly contract?: Contract;
  readonly draft: ContractDraft;
  /** What is still missing. Empty when settled. */
  readonly missing: readonly Gap[];
  readonly spend: Spend;
  readonly costUsd: number;
  readonly turns: number;
}

/**
 * Conduct the interview.
 *
 * Returns rather than throws on an insufficient file: which answers are missing
 * is the useful output of that run, and the caller prints them.
 */
export async function interview(options: InterviewOptions): Promise<InterviewResult> {
  const { ask, file } = options;
  const interactive = ask !== undefined;
  const rates = ratesFor(options.model ?? DEFAULT_MODEL);
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const stallTurns = options.stallTurns ?? DEFAULT_STALL_TURNS;

  // Ordinary answers are the model reporting what it was told; the two
  // guardrails are not, and this is what stops them being recorded that way.
  const recording: Authorization =
    file === undefined ? { by: 'model' } : { by: 'file', text: file };

  let draft: ContractDraft = options.seed ?? {};
  const transcript: Exchange[] = [];
  let spend: Spend = ZERO_SPEND;
  let turns = 0;
  let quiet = 0;
  let ending: InterviewEnding | undefined;

  const costNow = (): number => (rates === undefined ? 0 : spendCost(spend, rates));
  const outstanding = (): readonly Gap[] => gaps(draft, { interactive });

  while (ending === undefined) {
    if (outstanding().length === 0) {
      ending = 'settled';
      break;
    }
    if (turns >= maxTurns) {
      ending = 'turn-limit';
      break;
    }
    // The interview's spend counts against the same ceiling discovery is given:
    // it is one run, and a budget that only bound half of it would not be one.
    if (draft.budgetUsd !== undefined && costNow() >= draft.budgetUsd) {
      ending = 'budget-exhausted';
      break;
    }
    if (quiet >= stallTurns) {
      ending = 'incomplete';
      break;
    }

    const turn = await options.converse(
      {
        interactive,
        ...(file === undefined ? {} : { file }),
        seeded: options.rerun ?? false,
        draft,
        outstanding: outstanding(),
        // A copy: the state a turn was decided on must not go on changing
        // underneath whoever holds it, and the seam may keep it.
        transcript: [...transcript],
      },
      INTERVIEW_TOOLS,
    );

    turns += 1;
    spend = addUsage(spend, turn.usage);
    transcript.push({
      kind: 'called',
      text: turn.text,
      calls: turn.calls,
      ...(turn.reasoning === undefined ? {} : { reasoning: turn.reasoning }),
    });

    if (turn.calls.length === 0) {
      // Same hazard as discovery's loop, and the interview is if anything more
      // exposed: a refusal comes back as an assistant message with no content,
      // and there is no tool call to answer, so the only alternative to saying
      // something here is an empty user message the provider rejects. The stall
      // guard still bounds it.
      transcript.push({ kind: 'nudge', text: NO_CALL });
      quiet += 1;
      continue;
    }

    const results: ToolResult[] = [];
    let moved = false;

    for (const call of turn.calls) {
      const say = (ok: boolean, detail: string): void =>
        void results.push({ id: call.id, ok, detail });

      if (!INTERVIEW_TOOL_NAMES.has(call.name)) {
        say(false, `there is no tool called ${call.name}`);
        continue;
      }

      try {
        switch (call.name) {
          case 'record': {
            const applied = applyAnswers(draft, patchOf(call), recording);
            draft = applied.draft;
            moved = true;
            say(
              applied.refused.length === 0,
              applied.refused.length === 0 ? summarize(outstanding()) : applied.refused.join('; '),
            );
            break;
          }

          case 'propose': {
            const proposal = proposalOf(call);
            if (ask === undefined) {
              // Unattended there is nobody to confirm, so a proposal is not an
              // answer. A human wrote and committed the file, which is why the
              // file — and only the file — can authorize one.
              say(
                false,
                `there is nobody to confirm ${proposal.field}; it counts only where the interview file states it`,
              );
              break;
            }

            const stated = Array.isArray(proposal.value)
              ? proposal.value.join(', ')
              : String(proposal.value);
            const answered = await ask({
              kind: 'confirm',
              text: `${proposal.field}: ${stated}${proposal.why === undefined ? '' : ` — ${proposal.why}`}`,
            });
            moved = true;

            if (!accepted(answered)) {
              say(false, `the user did not accept that ${proposal.field}; ask what it should be`);
              break;
            }

            const applied = applyAnswers(
              draft,
              proposal.field === 'allowlist'
                ? { allowlist: Array.isArray(proposal.value) ? proposal.value : [proposal.value] }
                : {
                    effects: {
                      securityEffect: (Array.isArray(proposal.value)
                        ? proposal.value[0]
                        : proposal.value) as never,
                    },
                  },
              { by: 'human' },
            );
            draft = applied.draft;
            say(true, `${proposal.field} confirmed. ${summarize(outstanding())}`);
            break;
          }

          case 'ask': {
            const question = call.input.question;
            if (ask === undefined) {
              say(false, 'there is nobody to ask; the interview file is all there is');
              break;
            }
            const answered = await ask({
              kind: 'open',
              text: typeof question === 'string' ? question : '',
            });
            moved = true;
            say(true, answered);
            break;
          }

          default: {
            const missing = outstanding();
            if (missing.length === 0) {
              ending = 'settled';
              say(true, 'settled');
              break;
            }
            // A model calling it done while answers are missing is told which,
            // and unattended that is the end of it: nobody is there to supply
            // them, and filling them in and re-running is the loop.
            say(false, summarize(missing));
            if (!interactive) {
              ending = 'incomplete';
            }
            break;
          }
        }
      } catch (error) {
        say(false, error instanceof ToolArgumentError ? error.message : String(error));
      }
    }

    transcript.push({ kind: 'results', results });
    quiet = moved ? 0 : quiet + 1;
  }

  const missing = outstanding();
  const settled = ending === 'settled' && missing.length === 0;

  return {
    ending: settled ? 'settled' : ending === 'settled' ? 'incomplete' : ending,
    ...(settled ? { contract: settle(draft, { interactive }) } : {}),
    draft,
    missing,
    spend,
    costUsd: costNow(),
    turns,
  };
}

/** What is still outstanding, in one line the model can act on. */
function summarize(missing: readonly Gap[]): string {
  return missing.length === 0
    ? 'every answer is in'
    : `still needed: ${missing.map((gap) => gap.id).join(', ')}`;
}
