/**
 * The command line Interfacer is run with.
 *
 * ```
 * npx interfacer <project-name> [--root <dir>] [--interview <path>]
 * ```
 *
 * The goal and the entry point are deliberately not arguments. They are
 * established in the interview, interactively or from the interview file: a goal
 * is a paragraph rather than a flag, and the interview has to interrogate it
 * anyway to get the contract out of it.
 */
export interface Invocation {
  /** Names both the directory and, by proposal, the capability. */
  readonly projectName: string;
  /** Where generated projects live. The current directory by default. */
  readonly root: string;
  /**
   * Pre-answered interview questions. Supplying it makes the run
   * non-interactive: there is nobody to ask, so an insufficient file exits
   * saying which answers are missing.
   */
  readonly interviewPath?: string;
}

export class BadInvocation extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export const USAGE = `usage: interfacer <project-name> [--root <dir>] [--interview <path>]

  <project-name>      names the directory and the capability
  --root <dir>        where generated projects live (default: the current directory)
  --interview <path>  pre-answered interview questions, as markdown prose;
                      supplying it makes the run non-interactive

The goal and the entry point are established in the interview, not on the
command line. API_KEY is read from the environment, and MODEL where the default
is overridden — neither is an argument, because argv lands in shell history.
`;

const WITH_VALUE = new Set(['--root', '--interview']);

/** Parse the arguments, or say what is wrong with them. */
export function parseArgv(argv: readonly string[], cwd: string): Invocation | 'help' {
  let projectName: string | undefined;
  let root: string | undefined;
  let interviewPath: string | undefined;

  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';

    if (arg === '--help' || arg === '-h') {
      return 'help';
    }

    if (WITH_VALUE.has(arg)) {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new BadInvocation(`${arg} needs a value`);
      }
      if (arg === '--root') {
        root = value;
      } else {
        interviewPath = value;
      }
      at += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new BadInvocation(`unknown option ${arg}`);
    }

    if (projectName !== undefined) {
      throw new BadInvocation(`unexpected argument ${JSON.stringify(arg)}`);
    }
    projectName = arg;
  }

  if (projectName === undefined) {
    throw new BadInvocation('a project name is required');
  }

  return {
    projectName,
    root: root ?? cwd,
    ...(interviewPath === undefined ? {} : { interviewPath }),
  };
}
