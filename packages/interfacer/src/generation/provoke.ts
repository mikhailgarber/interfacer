/**
 * Reaching the states a task can end in besides success.
 *
 * The interview declared what those are; generation has to find the page
 * condition that detects each one, and the only honest way to find it is to
 * deliberately reach the state — an account reference that does not exist, a
 * user without the entitlement. A declared outcome that cannot be reached gets
 * no detector and is reported **unverified**, never guessed: a recorded guess
 * would leave the arm in the contract while the condition it names arrived at
 * replay as a hard failure, which is worse than nothing.
 *
 * Interfacer drives the sequence rather than the model, because the sequence is
 * fixed: obtain a provoking value, re-run what the flow already holds, and let
 * the model name what it sees. The re-run performs the steps without appending
 * them — the flow is already built, and provoking an outcome must not grow it.
 */
import {
  openExecution,
  resolveTarget,
  addUsage,
  ZERO_SPEND,
  type FieldSet,
  type Flow,
  type Observation,
  type RunOptions,
  type Spend,
  type TargetChain,
} from '@interfacer/dsl';

import type { Ask } from '../ask.js';
import type { ContractBrief, Decide, Exchange, ToolCall, ToolDefinition } from '../agent/decide.js';
import { answerFor, bindValue, TOOLS } from '../agent/tools.js';
import type { OutcomeAnswer } from '../interview/contract.js';
import { rerunFlow } from './rerun.js';

/** What the model may do while provoking: observe, ask, and declare. */
const PROVOKE_TOOLS: readonly ToolDefinition[] = TOOLS.filter((tool) =>
  ['ask', 'snapshot', 'screenshot', 'outcome'].includes(tool.name),
);

/** Turns allowed per phase. A provocation that needs more is not one. */
const DEFAULT_TURNS = 4;

export interface ProvokeOptions extends RunOptions {
  readonly decide: Decide;
  readonly ask?: Ask;
  /** The live values, shared with discovery: a provoking one is bound here. */
  readonly live: Record<string, unknown>;
  readonly turnsPerPhase?: number;
}

export interface Provoked {
  readonly outcome: OutcomeAnswer;
  /** Whether the state was reached and a detector recorded for it. */
  readonly verified: boolean;
  /** Why it was not, where it was not. Reported, never turned into a guess. */
  readonly why?: string;
}

export interface Provocations {
  readonly provoked: readonly Provoked[];
  readonly spend: Spend;
}

/**
 * Provoke every declared outcome the flow has no detector for.
 *
 * Each gets its own session: the page has to be brought back to the start with
 * a different value, and a run that already failed its way into one outcome is
 * not where the next one is found.
 */
export async function provokeOutcomes(
  flow: Flow<FieldSet, unknown>,
  declared: readonly OutcomeAnswer[],
  options: ProvokeOptions,
): Promise<Provocations> {
  const provoked: Provoked[] = [];
  let spend: Spend = ZERO_SPEND;

  for (const outcome of declared) {
    if (flow.outcomes.some((one) => one.id === outcome.id)) {
      // Discovery reached it on the way past. Nothing to provoke.
      provoked.push({ outcome, verified: true });
      continue;
    }

    const attempt = await provokeOne(flow, outcome, options);
    spend = addUsage(spend, attempt.usage);
    provoked.push(attempt.result);
  }

  return { provoked, spend };
}

interface Attempt {
  readonly result: Provoked;
  readonly usage: Spend;
}

async function provokeOne(
  flow: Flow<FieldSet, unknown>,
  outcome: OutcomeAnswer,
  options: ProvokeOptions,
): Promise<Attempt> {
  const turns = options.turnsPerPhase ?? DEFAULT_TURNS;
  const transcript: Exchange[] = [];
  let spend: Spend = ZERO_SPEND;

  const brief: ContractBrief = {
    capability: flow.id,
    inputNames: Object.keys(flow.input),
    outcomes: [outcome.id],
    allowlist: [...flow.declaredAllowlist],
  };

  // `Infer<FieldSet>` is `Record<string, never>`: the flow's input type is not
  // known here, because it came from an interview rather than from source.
  const execution = await openExecution(flow, options.live as never, {
    ...options,
    phase: 'discovery',
    headless: options.headless ?? false,
  });

  const give = async (task: string, observation: Observation): Promise<readonly ToolCall[]> => {
    const turn = await options.decide(
      {
        task,
        contract: brief,
        observation,
        transcript: [...transcript],
        budget: { capUsd: Number.POSITIVE_INFINITY, spentUsd: 0 },
      },
      PROVOKE_TOOLS,
    );
    spend = addUsage(spend, turn.usage);
    transcript.push({ kind: 'called', text: turn.text, calls: turn.calls });
    return turn.calls;
  };

  const unverified = (why: string): Attempt => ({
    result: { outcome, verified: false, why },
    usage: spend,
  });

  try {
    // Phase one: a value that reaches the state. The person supplies it — they
    // are the only one who knows which account does not exist.
    let bound = false;
    for (let turn = 0; turn < turns && !bound; turn += 1) {
      const calls = await give(
        `Reach the declared outcome ${JSON.stringify(outcome.id)}${
          outcome.description === undefined ? '' : ` — ${outcome.description}`
        }. Ask for an input value that would take the task there, naming the input in "for". Do not act on the page yet.`,
        await execution.observe(),
      );
      const results = [];
      for (const call of calls) {
        if (call.name !== 'ask') {
          results.push({ id: call.id, ok: false, detail: 'ask for the value first' });
          continue;
        }
        const answered = await put(call, options);
        const name = call.input.for;
        const declaredField = typeof name === 'string' ? flow.input[name] : undefined;
        if (declaredField === undefined || typeof name !== 'string') {
          results.push({ id: call.id, ok: false, detail: 'name a declared input in "for"' });
          continue;
        }
        options.live[name] = bindValue(declaredField, answered);
        bound = true;
        results.push({ id: call.id, ok: true, detail: `${name} is set; I will re-run the flow` });
      }
      transcript.push({ kind: 'results', results });
    }

    if (!bound) {
      return unverified('no provoking value was obtained');
    }

    // Phase two: re-run what the flow already holds. A step failing here is the
    // point: the provoking value has taken the application into the state, and
    // the page in front of us is the one the detector has to match.
    const reached = await rerunFlow(execution, flow);
    if (reached.stoppedAt === undefined) {
      return unverified('the flow ran to the end with that value: the state was never reached');
    }

    // Phase three: name the condition. The tool refuses a detector that does not
    // match the page, so an outcome cannot be declared against a guess.
    for (let turn = 0; turn < turns; turn += 1) {
      const calls = await give(
        `This is the page that value produced. Declare the outcome ${JSON.stringify(
          outcome.id,
        )} with a target that matches the condition on it, best-first.`,
        await execution.observe(),
      );
      const results = [];
      for (const call of calls) {
        if (call.name !== 'outcome') {
          results.push({ id: call.id, ok: false, detail: 'declare the outcome' });
          continue;
        }
        const detector = call.input.detector as TargetChain;
        const found = await resolveTarget(execution.page, detector, 'present', 0);
        if (!found.found) {
          results.push({
            id: call.id,
            ok: false,
            detail: 'that detector does not match the page in front of you',
          });
          continue;
        }
        flow.outcome(
          detector,
          answerFor({ ...call, input: { ...call.input, status: outcome.id } }),
          {
            id: outcome.id,
          },
        );
        return { result: { outcome, verified: true }, usage: spend };
      }
      transcript.push({ kind: 'results', results });
    }

    return unverified('the state was reached but no detector matched it');
  } finally {
    execution.finishedWith({ ending: 'success' });
    await execution.close();
  }
}

/** Put the model's question to the person, or say there is nobody there. */
async function put(call: ToolCall, options: ProvokeOptions): Promise<string> {
  const question = call.input.question;
  if (options.ask === undefined) {
    return 'there is nobody to ask';
  }
  return options.ask({ kind: 'open', text: typeof question === 'string' ? question : '' });
}
