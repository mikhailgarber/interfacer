/**
 * The discovery loop, which Interfacer owns.
 *
 * Not an SDK helper's loop, because four things happen between turns and all of
 * them are Interfacer's responsibility: the allowlist is checked on any
 * navigation, the successful step is appended, the run record gets its entries,
 * and spend is accumulated against the budget. A helper that owned the loop
 * would own three of those by accident and none of them on purpose.
 *
 * The engine underneath is the same one replay uses — {@link openExecution}
 * walked a step at a time rather than start to finish. Discovery is not a
 * different way of executing, only a different way of deciding what to execute
 * next, which is what makes "it worked during discovery" a claim about replay.
 */
import {
  addUsage,
  describeTarget,
  isReplayError,
  openExecution,
  ratesFor,
  resolveTarget,
  spendCost,
  ZERO_SPEND,
  type FieldSet,
  type Flow,
  type Infer,
  type Observation,
  type RunOptions,
  type Spend,
  type Step,
  type TargetChain,
} from '@interfacer/dsl';

import { accepted, type Ask } from '../ask.js';
import { rerunFlow, type Rerun } from '../generation/rerun.js';
import {
  DEFAULT_MODEL,
  type ContractBrief,
  type Decide,
  type Exchange,
  type ToolCall,
  type ToolResult,
} from './decide.js';
import { answerFor, appendStep, bindValue, TOOL_NAMES, TOOLS, ToolArgumentError } from './tools.js';

/**
 * How many turns may pass with nothing appended and the page unchanged.
 *
 * Both conditions, deliberately. Counting only page changes would end a run that
 * is legitimately looking before it acts; counting only appended steps would end
 * one that is working through a screen it cannot yet act on. A run that is doing
 * neither has stopped changing the page, and should not spend the rest of the
 * ceiling proving it.
 */
const DEFAULT_STALL_TURNS = 3;

/**
 * A bound on turns, distinct from the budget.
 *
 * The budget bounds a run that costs money. A provider that costs nothing and
 * proposes something new every turn — a fake, or a loop in the caller — is
 * bounded by nothing else, and a run that never ends is worse than one that ends
 * badly.
 */
const DEFAULT_MAX_TURNS = 60;

export interface DiscoveryOptions<I extends FieldSet = FieldSet> extends RunOptions {
  /** What the capability is for, in the words the interview captured. */
  readonly task: string;
  /**
   * Live values for the declared inputs. Held for the run, written nowhere.
   *
   * Typed against the flow's own declaration rather than against `FieldSet`:
   * `Infer<FieldSet>` resolves to `Record<string, never>`, which accepts a value
   * only where the compiler happens not to check it freshly.
   */
  readonly input: Infer<I>;
  readonly decide: Decide;
  /**
   * The person in the session, asked in prose.
   *
   * Distinct from `resolver`, which the engine uses for a pause in the flow
   * being discovered: a pause needs a value of a known kind, and a question the
   * model asks — for a live value, or for a way to reach a state it cannot find
   * — has no such shape. Its absence is what makes a discovery run unattended.
   */
  readonly ask?: Ask;
  /** Which model is being paid for. Rates come from it; the id is configuration. */
  readonly model?: string;
  /** The hard cap, in dollars. The model is told it; the harness enforces it. */
  readonly budgetUsd?: number;
  /**
   * What to do at the cap, where there is somebody to ask.
   *
   * Interactively, reaching the ceiling is an approval rather than a failure:
   * approving raises it and the run continues in the same session. Returning
   * nothing — or omitting this, which is what an unattended run does — stops
   * the run, and the partial flow is written for a re-run to continue from.
   */
  readonly raiseBudget?: (spent: number, cap: number) => Promise<number | undefined>;
  readonly maxTurns?: number;
  readonly stallTurns?: number;
  /** Declared outcomes still needing a detector, for the model's brief. */
  readonly outcomes?: readonly string[];
  /**
   * The flow already has steps: verify them before deciding anything new.
   *
   * This is seeded discovery. A sibling project copied to a new tenant is
   * verified rather than trusted — its steps are re-performed against the new
   * application, the ones that still resolve are kept, and the run picks up
   * from the first one that does not, which is retracted along with everything
   * after it. Copying a project and editing the URL keeps a sibling's steps
   * unchecked; copying it and running Interfacer keeps only what still works.
   */
  readonly verifySeed?: boolean;
}

/** Why discovery stopped. */
export type Ending =
  /** `returns` was called and verified: the goal is reached. */
  | 'returned'
  | 'budget-exhausted'
  | 'stalled'
  | 'turn-limit'
  /** The engine raised a hard failure the loop could not continue past. */
  | 'failed';

export interface Discovery<I extends FieldSet = FieldSet> {
  readonly ending: Ending;
  /** What a seeded run kept and where it stopped, where one was verified. */
  readonly seeded?: Rerun;
  /** The flow as it stands. Partial where the run did not reach the goal. */
  readonly flow: Flow<I, unknown>;
  readonly spend: Spend;
  readonly costUsd: number;
  readonly turns: number;
  /** The hard failure, where one ended the run. */
  readonly failure?: Error;
}

/** What a turn did to the page, for the stall guard to compare. */
function signature(observation: Observation): string {
  return `${observation.url}\n${observation.tree}`;
}

/**
 * Drive a model through the task, appending what works.
 *
 * The session is headed: discovery is supervised, and a human can watch it and
 * take over.
 */
export async function discover<I extends FieldSet>(
  flow: Flow<I, unknown>,
  options: DiscoveryOptions<I>,
): Promise<Discovery<I>> {
  const model = options.model ?? DEFAULT_MODEL;
  const rates = ratesFor(model);
  let cap = options.budgetUsd ?? Number.POSITIVE_INFINITY;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const stallTurns = options.stallTurns ?? DEFAULT_STALL_TURNS;

  // The engine reads an input at the moment a step needs it, so this is the one
  // object a live value ever lives in — filled as the model asks for values, and
  // gone when the process is.
  const live = options.input as Record<string, unknown>;

  const execution = await openExecution(flow, options.input, {
    ...options,
    phase: 'discovery',
    // Headed by default: discovery is watched, and an operator pause hands over
    // the window that is already open.
    headless: options.headless ?? false,
  });

  let ending: Ending | undefined;

  // Seeded: walk what the seed already holds, and drop from the first step the
  // new application refuses. Retracted last-first, because a flow is a sequence
  // and a step after a broken one has no established place to stand.
  let seeded: Rerun | undefined;
  if (options.verifySeed === true && flow.steps.length > 0) {
    seeded = await rerunFlow(execution, flow);
    for (const step of [...flow.steps].reverse()) {
      if (seeded.kept.includes(step)) {
        break;
      }
      flow.retract(step);
    }

    // Every step still resolves and the seed already declares its result: the
    // capability is confirmed against this tenant and there is nothing left for
    // a model to decide. Asking it anyway would spend a turn to be told so.
    if (seeded.stoppedAt === undefined && flow.result !== undefined) {
      ending = 'returned';
    }
  }

  const transcript: Exchange[] = [];
  const contract: ContractBrief = {
    capability: flow.id,
    inputNames: Object.keys(flow.input),
    outcomes: options.outcomes ?? [],
    allowlist: [...flow.declaredAllowlist],
  };

  let spend: Spend = ZERO_SPEND;
  let turns = 0;
  let quiet = 0;
  let lastSignature = '';
  let failure: Error | undefined;

  const costNow = (): number => (rates === undefined ? 0 : spendCost(spend, rates));

  try {
    while (ending === undefined) {
      if (turns >= maxTurns) {
        ending = 'turn-limit';
        break;
      }

      // The harness holds the cap. The model is told the ceiling so it paces
      // itself, and being told is not a control.
      if (costNow() >= cap) {
        const raised = await options.raiseBudget?.(costNow(), cap);
        if (raised === undefined || raised <= cap) {
          ending = 'budget-exhausted';
          break;
        }
        cap = raised;
      }

      const observation = await execution.observe();
      const now = signature(observation);
      quiet = now === lastSignature ? quiet + 1 : 0;
      lastSignature = now;

      if (quiet >= stallTurns) {
        // An agent retrying the same thing should not spend the rest of the
        // ceiling doing it.
        ending = 'stalled';
        break;
      }

      const turn = await options.decide(
        {
          task: options.task,
          contract,
          observation,
          // A copy: the state a turn was decided on must not go on changing
          // underneath whoever holds it, and the seam may keep it.
          transcript: [...transcript],
          budget: { capUsd: cap, spentUsd: costNow() },
        },
        TOOLS,
      );

      turns += 1;
      spend = addUsage(spend, turn.usage);
      transcript.push({ kind: 'called', text: turn.text, calls: turn.calls });

      const results: ToolResult[] = [];
      let appended = false;

      for (const call of turn.calls) {
        execution.record({
          kind: 'model.turn',
          reason: call.reason ?? turn.text,
          tool: call.name,
          usage: turn.usage,
          costUsd: rates === undefined ? 0 : costNow(),
        });

        const done = await run(call, results);
        appended ||= done.appended;
        if (done.ending !== undefined) {
          ending = done.ending;
          break;
        }
      }

      transcript.push({ kind: 'results', results });
      if (appended) {
        quiet = 0;
      }
    }
  } catch (error) {
    await execution.failedWith(error);
    ending = 'failed';
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    execution.finishedWith(
      ending === 'returned'
        ? { ending: 'success' }
        : { ending: 'failure', category: ending ?? 'failed' },
    );
    await execution.close();
  }

  return {
    ending,
    flow,
    spend,
    costUsd: costNow(),
    turns,
    ...(seeded === undefined ? {} : { seeded }),
    ...(failure === undefined ? {} : { failure }),
  };

  /** One tool call: perform it, and keep it only if the application accepted it. */
  async function run(
    call: ToolCall,
    results: ToolResult[],
  ): Promise<{ appended: boolean; ending?: Ending }> {
    const say = (ok: boolean, detail: string): void => {
      results.push({ id: call.id, ok, detail });
    };

    if (!TOOL_NAMES.has(call.name)) {
      say(false, `there is no tool called ${call.name}`);
      return { appended: false };
    }

    try {
      switch (call.name) {
        case 'snapshot': {
          const seen = await execution.observe();
          say(true, `${seen.title} — ${seen.url}\n\n${seen.tree}`);
          return { appended: false };
        }

        case 'screenshot': {
          const image = await execution.screenshot();
          // A screenshot informs a decision and can never be a target: nothing
          // durable is recordable from a coordinate, so what comes back says
          // what was seen and the model still has to name an element.
          say(
            image !== undefined,
            image === undefined
              ? 'the declared dataClasses permit no pixels; use the accessibility tree'
              : `a ${String(image.length)}-byte image was taken; identify anything you act on in the tree`,
          );
          return { appended: false };
        }

        case 'ask': {
          const asked = call.input.question;
          const answered = await ask(typeof asked === 'string' ? asked : '');
          const bound = bind(call.input.for, answered);
          say(true, bound === undefined ? answered : `${answered} — bound to ${bound}`);
          return { appended: false };
        }

        case 'outcome': {
          const detector = call.input.detector as TargetChain;
          const found = await resolveTarget(execution.page, detector, 'present', 0);
          if (!found.found) {
            // A detector that cannot be provoked gets no declaration: recording
            // a guess is worse than nothing, because the arm would exist in the
            // contract while the condition it names arrived as a hard failure.
            say(false, 'that detector does not match the page in front of you');
            return { appended: false };
          }
          flow.outcome(detector, answerFor(call));
          say(true, `outcome ${String(call.input.status)} declared`);
          return { appended: true };
        }

        case 'returns': {
          flow.returns(answerFor(call));
          const produced = execution.result();
          say(true, `returns declared: ${JSON.stringify(produced)}`);
          return { appended: true, ending: 'returned' };
        }

        case 'commit': {
          // The point of no return is proposed and confirmed rather than
          // inferred: `.commit()` is marked in the flow because a person said
          // this is the step, and an approval that came after the fact would
          // be authorizing something already done.
          if (options.ask !== undefined) {
            const answered = await options.ask({
              kind: 'confirm',
              text: `${(call.input.target as TargetChain).map(describeTarget).join(' | ')} is the point of no return`,
            });
            if (!accepted(answered)) {
              say(false, 'the user says that is not the commit; do not activate it');
              return { appended: false };
            }
          }
          return await perform(call, say);
        }

        default:
          return await perform(call, say);
      }
    } catch (error) {
      if (isReplayError(error)) {
        throw error;
      }
      // A step that fails is information the model acts on — a different
      // target, a different approach — not a run-ending event.
      say(false, error instanceof Error ? error.message : String(error));
      return { appended: false };
    }
  }

  /** Append the step, perform it, and take it back if it did not work. */
  async function perform(
    call: ToolCall,
    say: (ok: boolean, detail: string) => void,
  ): Promise<{ appended: boolean; ending?: Ending }> {
    let step: Step;
    try {
      step = appendStep(flow, call);
    } catch (error) {
      say(false, error instanceof ToolArgumentError ? error.message : String(error));
      return { appended: false };
    }

    try {
      const reached = await execution.perform(step);
      say(
        true,
        reached === undefined ? `${step.id} done` : `${step.id} matched a declared outcome`,
      );
      return { appended: true, ...(reached === undefined ? {} : { ending: 'returned' as const }) };
    } catch (error) {
      flow.retract(step);
      say(
        false,
        isReplayError(error) ? `${error.expected} — observed ${error.observed}` : String(error),
      );
      return { appended: false };
    }
  }

  async function ask(question: string): Promise<string> {
    if (options.ask === undefined) {
      return 'there is nobody to ask; carry on with what the page gives you';
    }
    // The answer is whatever the person says. A live value they give here is
    // held for the run and written nowhere — not into the project, not into the
    // record — so nothing about it reaches the artifact but its input name.
    return options.ask({ kind: 'open', text: question });
  }

  /**
   * Hold an answer as the value of a declared input, for the rest of the run.
   *
   * Discovery needs real values to work with — a username that logs in, an
   * account that exists — and the model asks for them as it needs them rather
   * than being handed everything up front. They live in this object and nowhere
   * else: the flow refers to inputs by accessor, so the artifact is
   * parameterized by construction and never sees one.
   */
  function bind(name: unknown, answered: string): string | undefined {
    if (typeof name !== 'string' || name === '') {
      return undefined;
    }
    const declared = flow.input[name];
    if (declared === undefined) {
      return undefined;
    }
    live[name] = bindValue(declared, answered);
    return name;
  }
}
