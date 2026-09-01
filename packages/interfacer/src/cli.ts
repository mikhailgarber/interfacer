#!/usr/bin/env node
/**
 * `npx interfacer <project-name> [--root <dir>] [--interview <path>]`
 *
 * The shell of a session. A run is two phases — an interview that establishes
 * the contract, and generation, which discovers the flow against the live
 * application and emits the project — and it is *one* session with a human in
 * it: the conversation does not end when the interview does.
 *
 * Everything here talks on **stderr**. Discovery's run record goes to stdout by
 * default, and a conversation interleaved with it would corrupt a stream
 * somebody is meant to be able to read as JSON lines.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { credentials, interviewer, MissingCredential, type Credentials } from './agent/decide.js';
import type { Contract, ContractDraft } from './interview/contract.js';
import type { Ask } from './ask.js';
import { interview } from './interview/interview.js';
import { BadInvocation, parseArgv, USAGE, type Invocation } from './interview/invoke.js';
import {
  BadProjectName,
  capabilityFrom,
  resolveLocation,
  type Location,
} from './interview/locate.js';
import { recordedAnswers } from './interview/read.js';

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((accept) => {
    rl.question(question, (line) => {
      rl.close();
      accept(line);
    });
  });
}

/**
 * The human channel, and the thing that makes a run interactive.
 *
 * A proposal is put with its default visible, because the two Interfacer
 * proposes rather than asks are the two a person is most likely to accept
 * without reading — and the whole point of the confirmation is that they read it.
 */
const keyboard: Ask = async (question) => {
  const answered = await prompt(
    question.kind === 'confirm' ? `${question.text}\n  accept? [y/N] ` : `${question.text}\n> `,
  );
  return answered.trim();
};

/** What the interview settled, in the order it was established. */
function describe(contract: Contract): readonly string[] {
  const inputs = contract.inputs.map(
    (input) =>
      `    ${input.name} (${input.kind})${input.description === undefined ? '' : ` — ${input.description}`}`,
  );
  const outcomes = contract.outcomes.map(
    (outcome) =>
      `    ${outcome.id}${outcome.description === undefined ? '' : ` — ${outcome.description}`}`,
  );
  const interactions = contract.interactions.map(
    (one) => `    ${one.name} (${one.kind}) — ${one.prompt}`,
  );
  const effects = Object.entries(contract.effects).map(
    ([key, value]) => `    ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`,
  );

  return [
    `  capability   ${contract.capability}`,
    `  task         ${contract.task}`,
    `  entry point  ${contract.entryPoint}`,
    `  returns      ${contract.output}`,
    '  inputs',
    ...(inputs.length === 0 ? ['    none'] : inputs),
    '  outcomes besides success',
    ...(outcomes.length === 0 ? ['    none'] : outcomes),
    '  interactions',
    ...(interactions.length === 0 ? ['    none — it can run unattended'] : interactions),
    '  effects',
    ...effects,
    `  allowlist    ${contract.allowlist.join(', ')} (${contract.authority.allowlist})`,
    ...(contract.budgetUsd === undefined
      ? []
      : [`  budget       $${contract.budgetUsd.toFixed(2)}`]),
  ];
}

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  let invocation: Invocation | 'help';
  try {
    invocation = parseArgv(argv, process.cwd());
  } catch (error) {
    say(error instanceof BadInvocation ? `interfacer: ${error.message}` : String(error));
    say('');
    say(USAGE);
    return 2;
  }

  if (invocation === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  // Before a browser opens or the first question is asked, so a missing key
  // costs a second rather than an entire interview.
  let using: Credentials;
  try {
    using = credentials(env);
  } catch (error) {
    say(`interfacer: ${error instanceof MissingCredential ? error.message : String(error)}`);
    return 1;
  }

  let file: string | undefined;
  if (invocation.interviewPath !== undefined) {
    try {
      file = readFileSync(invocation.interviewPath, 'utf8');
    } catch {
      say(`interfacer: cannot read the interview file ${invocation.interviewPath}`);
      return 1;
    }
  }

  let location: Location;
  try {
    location = resolveLocation(invocation.root, invocation.projectName);
  } catch (error) {
    say(`interfacer: ${error instanceof BadProjectName ? error.message : String(error)}`);
    return 2;
  }

  // An occupied location is a project update: the project's own declarations
  // are the recorded answers, so the interview is a delta rather than a repeat.
  const recorded = location.state === 'occupied' ? recordedAnswers(location.path) : {};
  const proposed = capabilityFrom(invocation.projectName);
  const seed: ContractDraft = {
    ...recorded,
    // The project name proposes the capability id; the interview settles it like
    // any other answer.
    ...(recorded.capability === undefined && proposed !== undefined
      ? { capability: proposed }
      : {}),
  };

  say(
    `interfacer: ${location.path} (${location.state === 'occupied' ? 'updating the project that is there' : 'a new project'})`,
  );
  say('');

  const result = await interview({
    converse: interviewer(using),
    model: using.model,
    // The flag is what takes the human out of the session. Without one there is
    // somebody to ask, and asking is the normal way to record a capability.
    ...(file === undefined ? { ask: keyboard } : { file }),
    seed,
    // A rerun only where a project was actually there: the capability id a new
    // directory name proposes is not a delta from anything.
    rerun: location.state === 'occupied',
  });

  if (result.contract === undefined) {
    say('');
    say('interfacer: the interview is not settled. Missing:');
    for (const gap of result.missing) {
      say(`  ${gap.id} — ${gap.question}`);
    }
    if (file !== undefined) {
      // The file is an input only, and never written back: what is missing goes
      // into the file by hand, and re-running is the loop.
      say('');
      say(`Add these to ${String(invocation.interviewPath)} and run it again.`);
    }
    return 1;
  }

  say('');
  say('interfacer: the contract is settled.');
  for (const line of describe(result.contract)) {
    say(line);
  }
  say('');
  say(`  the interview cost $${result.costUsd.toFixed(4)} over ${String(result.turns)} turns`);
  say('');
  // Phase 10 replaces this with the switch to generation mode: the same session
  // goes on, driving the model through the task against the live application.
  say('Generation mode — discovering the flow and writing the project — is phase 10.');
  return 0;
}

process.exitCode = await main(process.argv.slice(2), process.env);
