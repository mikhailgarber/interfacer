/**
 * Generation mode: the stage of a session that discovers the flow and writes
 * the project.
 *
 * The interview settled the contract; this drives the model through the task
 * against the live application, and every step that works is appended — so the
 * artifact accumulates as a by-product of doing the task rather than being
 * reconstructed afterwards from a transcript. The conversation does not stop
 * here: the person supplies live values as the model asks for them, confirms
 * the point of no return, and confirms what the pages say the application is.
 *
 * The order is deliberate. The goal first, because a detector for an outcome is
 * only findable once the steps that reach the screen exist; then the declared
 * outcomes, provoked one at a time; then what the application says about
 * itself; then the project. A run that stops early skips the rest and writes
 * what it has, because a re-run continues from the project rather than from
 * nothing.
 */
import {
  checkSafety,
  type Effects,
  type FieldSet,
  type Flow,
  type RunOptions,
  type SafetyViolation,
  type SecurityEffect,
  type Spend,
  type Step,
  type VariantStamp,
  addUsage,
  ratesFor,
  spendCost,
  ZERO_SPEND,
} from '@interfacer/dsl';

import { accepted, type Ask } from '../ask.js';
import { DEFAULT_MODEL, type Decide } from '../agent/decide.js';
import { bindValue } from '../agent/tools.js';
import { discover, type Ending } from '../agent/loop.js';
import { generateProject, type ProjectFiles } from '../generate/project.js';
import { writeProject } from '../generate/write.js';
import type { Contract } from '../interview/contract.js';
import { flowFor, liveValues } from './flow.js';
import { inspect } from './inspect.js';
import { provokeOutcomes, type Provoked } from './provoke.js';
import { readSeed, type Seed } from './seed.js';

export interface GenerationOptions extends RunOptions {
  readonly contract: Contract;
  readonly decide: Decide;
  /** The person in the session. Absent means unattended: nothing is confirmed. */
  readonly ask?: Ask;
  /** Where the project is written. The location the CLI resolved. */
  readonly root: string;
  /** The npm package name — the directory's name, not the capability id. */
  readonly packageName: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly stallTurns?: number;
  /** The turn bound each provocation phase gets. Forwarded to `provokeOutcomes`. */
  readonly turnsPerPhase?: number;
}

export interface Generation {
  readonly ending: Ending;
  readonly flow: Flow<FieldSet, unknown>;
  /** Every declared outcome, and whether a detector was recorded for it. */
  readonly outcomes: readonly Provoked[];
  readonly variant: VariantStamp;
  readonly effects: Effects;
  readonly files: ProjectFiles;
  readonly root: string;
  readonly spend: Spend;
  readonly costUsd: number;
  /** A flow that cannot satisfy its own declaration, where it does not. */
  readonly violation?: SafetyViolation;
  /**
   * Navigations whose page nothing used, by step id. Empty where there are none.
   *
   * Reported with the run rather than removed from the flow: what was recorded
   * is what happened, and this says only that it was more than the task needed.
   */
  readonly wasted: readonly string[];
  /** What was read from a project already in the location, where one was. */
  readonly seed?: Seed;
}

/**
 * Navigations whose page nothing ever used, by step id.
 *
 * An `open` immediately followed by another is waste every replay pays for, and
 * it reads to a later reviewer as though it mattered. A live run against a real
 * site opened a page of search results and navigated away without touching
 * them — so the state a declared outcome was defined against ("the first result
 * is not a company") was never on screen to be detected at all.
 *
 * Reported rather than removed. The artifact is what happened, and a step
 * deleted after the fact would make it something else — the same reason an
 * outcome that could not be provoked is reported rather than guessed.
 *
 * A property of the finished flow, so it holds whatever the model does, which
 * is what distinguishes it from every other guard against recording the wrong
 * thing.
 */
export function deadNavigations(steps: readonly Step[]): readonly string[] {
  return steps.flatMap((step, index) =>
    step.kind === 'open' && steps[index + 1]?.kind === 'open' ? [step.id] : [],
  );
}

/** The host discovery actually ran against, for the stamp. */
function hostOf(entryPoint: string): string {
  try {
    return new URL(entryPoint).host;
  } catch {
    return entryPoint;
  }
}

/**
 * Discover the capability and write it out.
 *
 * Returns rather than throws on a run that stopped early: what it discovered is
 * still written, and which outcomes went unverified is the useful output.
 */
export async function generate(options: GenerationOptions): Promise<Generation> {
  const { ask, contract } = options;
  const rates = ratesFor(options.model ?? DEFAULT_MODEL);

  // A project already in this location is a seed, whether it was recorded here
  // or copied in from a sibling — the two are the same path, and the difference
  // between them is only how much still resolves. Nothing is trusted: the steps
  // are verified against this application before anything is added to them.
  const seed = readSeed(options.root, contract);
  const flow = seed?.flow ?? flowFor(contract);
  const live = liveValues(contract);

  // A seeded run verifies before it decides anything, and verifying means
  // *performing* the seed's steps — so its values have to be in hand before the
  // first one runs, rather than being asked for as the model reaches them.
  // They are still only ever held here.
  if (seed !== undefined && ask !== undefined) {
    for (const input of contract.inputs) {
      // Except what is already in hand. The entry point is bound before the run
      // starts, and asking for it again would put a settled answer back to the
      // person as though nobody had given it.
      if (live[input.name] !== undefined) {
        continue;
      }
      const answered = await ask({
        kind: 'open',
        text: `value for ${input.name}${input.description === undefined ? '' : ` — ${input.description}`}`,
        // A real credential, typed at a prompt: the channel is told so it does
        // not echo it onto the screen and into the scrollback.
        ...(input.kind === 'secret' ? { secret: true } : {}),
      });
      const declared = flow.input[input.name];
      if (declared !== undefined) {
        live[input.name] = bindValue(declared, answered);
      }
    }
  }

  let spend: Spend = ZERO_SPEND;

  const discovery = await discover(flow, {
    ...options,
    task: contract.task,
    entryPoint: contract.entryPoint,
    input: live as never,
    // Nobody to supply the values means nothing to verify against: an
    // unverified seed is the failure seeding exists to prevent, so the run
    // discovers from nothing rather than trusting it.
    ...(seed === undefined || ask === undefined ? {} : { verifySeed: true }),
    outcomes: contract.outcomes.map((outcome) => outcome.id),
    // At the cap, interactively, the ceiling is raised rather than the run
    // failing — approving is what raises it. Unattended there is nobody to ask,
    // so the run stops and the partial flow is written for a re-run.
    ...(ask === undefined || contract.budgetUsd === undefined
      ? {}
      : {
          raiseBudget: async (spent: number, cap: number): Promise<number | undefined> => {
            const answered = await ask({
              kind: 'confirm',
              text: `discovery has spent $${spent.toFixed(2)} of its $${cap.toFixed(2)} ceiling — raise it by $${cap.toFixed(2)}?`,
            });
            return accepted(answered) ? cap * 2 : undefined;
          },
        }),
    ...(contract.budgetUsd === undefined ? {} : { budgetUsd: contract.budgetUsd }),
  });

  spend = addUsage(spend, discovery.spend);

  // A run that never reached the goal has nothing to provoke an outcome from
  // and no complete path to look at: what it has is written, and that is all.
  const reached = discovery.ending === 'returned';

  // Hoisted so the emergency write below sees whatever these reached before a
  // later phase threw: an unconfirmed vendor is absent, not wrong.
  let effects: Effects = contract.effects;
  let vendor: string | undefined;
  let appVersion: string | undefined;

  const stamp = (): VariantStamp => ({
    capability: contract.capability,
    ...(vendor === undefined ? {} : { vendor }),
    ...(appVersion === undefined ? {} : { appVersion }),
    recordedAgainst: hostOf(contract.entryPoint),
    recordedOn: (options.now?.() ?? new Date()).toISOString().slice(0, 10),
  });

  // Everything from here on can throw, and discovery is the expensive,
  // unrepeatable part of a run: a provider that falls over while an outcome is
  // being provoked must not also cost the flow that was already proved. So the
  // project is written on the way out whatever happens, and the failure is
  // still raised — the operator learns the run failed *and* keeps the work.
  try {
    return await finish();
  } catch (error) {
    await write();
    throw error;
  }

  /** Emit the project from whatever the run established before it stopped. */
  async function write(): Promise<ProjectFiles> {
    const files = await generateProject({
      flow,
      packageName: options.packageName,
      description: contract.task,
      variant: stamp(),
      ...(effects === contract.effects ? {} : { effects }),
    });

    // An update rewrites what it must and leaves everything else where it is:
    // Interfacer is authoritative when it runs, and git is what makes that safe.
    await writeProject(files, options.root);
    return files;
  }

  async function finish(): Promise<Generation> {
    const outcomes: Provoked[] = [];
    if (reached && contract.outcomes.length > 0) {
      const provocations = await provokeOutcomes(flow, contract.outcomes, {
        ...options,
        live,
      });
      spend = addUsage(spend, provocations.spend);
      outcomes.push(...provocations.provoked);
    } else {
      outcomes.push(
        ...contract.outcomes.map((outcome) => ({
          outcome,
          verified: false,
          why: reached ? 'not attempted' : 'discovery did not reach the goal',
        })),
      );
    }

    if (reached) {
      const proposals = await inspect(flow, { ...options, live });
      spend = addUsage(spend, proposals.spend);

      vendor = await confirmed(ask, 'vendor', proposals.vendor);
      appVersion = await confirmed(ask, 'appVersion', proposals.appVersion);

      const revised = await confirmedSecurity(ask, proposals, contract.effects.securityEffect);
      if (revised !== contract.effects.securityEffect) {
        effects = { ...contract.effects, securityEffect: revised };
      }
    }

    const variant = stamp();

    // The flow was checked against its declaration before a browser opened, when
    // it was empty. It is worth checking again now that it has steps: a capability
    // whose confirmed effects demand an approval it never records is one every
    // replay will refuse, and saying so here costs a line rather than a run.
    const violation = checkSafety(
      { id: flow.id, effects, steps: flow.steps },
      { headless: options.headless ?? false },
    );

    const files = await write();

    return {
      ending: discovery.ending,
      flow,
      outcomes,
      variant,
      effects,
      files,
      root: options.root,
      ...(seed === undefined ? {} : { seed }),
      wasted: deadNavigations(flow.steps),
      spend,
      costUsd: rates === undefined ? 0 : spendCost(spend, rates),
      ...(violation === undefined ? {} : { violation }),
    };
  }
}

/**
 * A proposal is not an answer until a person says so.
 *
 * Unattended there is nobody to confirm, so the field is absent — which is the
 * right outcome for a stamp: a fabricated version reads as fact, and a missing
 * one reads as missing.
 */
async function confirmed(
  ask: Ask | undefined,
  field: string,
  proposed: string | undefined,
): Promise<string | undefined> {
  if (proposed === undefined || ask === undefined) {
    return undefined;
  }
  const answered = await ask({ kind: 'confirm', text: `${field}: ${proposed}` });
  return accepted(answered) ? proposed : undefined;
}

async function confirmedSecurity(
  ask: Ask | undefined,
  proposals: { readonly securityEffect?: SecurityEffect; readonly why?: string },
  declared: SecurityEffect,
): Promise<SecurityEffect> {
  const { securityEffect } = proposals;
  if (securityEffect === undefined || securityEffect === declared || ask === undefined) {
    return declared;
  }
  const answered = await ask({
    kind: 'confirm',
    text: `securityEffect: ${securityEffect} rather than ${declared}${
      proposals.why === undefined ? '' : ` — ${proposals.why}`
    }`,
  });
  return accepted(answered) ? securityEffect : declared;
}
