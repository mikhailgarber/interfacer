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

import {
  claude,
  credentials,
  interviewer,
  MissingCredential,
  type Credentials,
} from './agent/decide.js';
import { generate } from './generation/generation.js';
import type { Contract, ContractDraft } from './interview/contract.js';
import { keyboard, type Keyboard } from './keyboard.js';
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

/**
 * The human channel, and the thing that makes a run interactive.
 *
 * One reader for the whole session rather than one per question: stacked
 * readers double-echo what is typed and leave the process holding a stdin
 * nobody will close. A proposal is put with its default visible, because the
 * two Interfacer proposes rather than asks are the two a person is most likely
 * to accept without reading — and the whole point of the confirmation is that
 * they read it. An answer that is a credential is not echoed at all.
 */
function session(): Keyboard {
  return keyboard(process.stdin, process.stderr);
}

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

  // Held as a `const` so the narrowing above survives into `conduct` below: a
  // closure over a `let` reads its declared type, not what this line knows.
  const asked = invocation;

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
  if (asked.interviewPath !== undefined) {
    try {
      file = readFileSync(asked.interviewPath, 'utf8');
    } catch {
      say(`interfacer: cannot read the interview file ${asked.interviewPath}`);
      return 1;
    }
  }

  let location: Location;
  try {
    location = resolveLocation(asked.root, asked.projectName);
  } catch (error) {
    say(`interfacer: ${error instanceof BadProjectName ? error.message : String(error)}`);
    return 2;
  }

  // An occupied location is a project update: the project's own declarations
  // are the recorded answers, so the interview is a delta rather than a repeat.
  const recorded = location.state === 'occupied' ? recordedAnswers(location.path) : {};
  const proposed = capabilityFrom(asked.projectName);
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

  // One reader for the session, released when the session ends — a command
  // that has printed its summary must not sit holding stdin. Absent entirely
  // where an interview file took the human out of the run: there is nobody to
  // ask, so there is nothing to read.
  const asking = file === undefined ? session() : undefined;
  try {
    return await conduct();
  } finally {
    asking?.close();
  }

  async function conduct(): Promise<number> {
    const result = await interview({
      converse: interviewer(using),
      model: using.model,
      // The flag is what takes the human out of the session. Without one there is
      // somebody to ask, and asking is the normal way to record a capability.
      ...(asking === undefined ? {} : { ask: asking.ask }),
      ...(file === undefined ? {} : { file }),
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
        say(`Add these to ${String(asked.interviewPath)} and run it again.`);
      }
      return 1;
    }

    say('');
    say('interfacer: the contract is settled.');
    for (const line of describe(result.contract)) {
      say(line);
    }
    say('');
    say('interfacer: generation mode — driving the task against the application.');
    say('');

    // The same session goes on. The conversation does not end when the interview
    // does: the model asks for live values as it needs them, and the person
    // confirms the point of no return and what the pages say the application is.
    const generated = await generate({
      contract: result.contract,
      decide: claude(using),
      model: using.model,
      root: location.path,
      packageName: asked.projectName,
      // What a discovery run leaves behind. Both absent unless asked for: the
      // record's default is stdout, and rich capture has to land somewhere
      // somebody chose. What may be captured is still what the contract
      // declared, so a PII capability's screenshots are masked here too.
      ...(asked.record === undefined ? {} : { destination: asked.record }),
      ...(asked.attachmentDir === undefined ? {} : { attachmentDir: asked.attachmentDir }),
      ...(asking === undefined ? {} : { ask: asking.ask }),
    });

    const unverified = generated.outcomes.filter((one) => !one.verified);

    say('');
    if (generated.ending === 'returned') {
      say(`interfacer: wrote ${String(generated.files.size)} files to ${generated.root}`);
    } else {
      // The partial flow is still written: a re-run reads the project like any
      // other and continues from these steps rather than starting over.
      say(`interfacer: discovery stopped (${generated.ending}); the partial flow is written.`);
    }

    for (const one of unverified) {
      // Reported, never guessed: an arm whose detector was invented would exist
      // in the contract while the condition it names arrived as a hard failure.
      say(`  unverified outcome ${one.outcome.id}${one.why === undefined ? '' : ` — ${one.why}`}`);
    }

    if (generated.violation !== undefined) {
      say(`  the flow does not satisfy its own declaration: ${generated.violation.expected}`);
    }

    say('');
    // Interactively there is nothing to bound, so Interfacer reports instead. That
    // number is what a person writes into an interview file to run one unattended.
    say(
      `  discovery cost $${generated.costUsd.toFixed(4)}; the interview cost $${result.costUsd.toFixed(4)}`,
    );
    return generated.ending === 'returned' ? 0 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2), process.env);
