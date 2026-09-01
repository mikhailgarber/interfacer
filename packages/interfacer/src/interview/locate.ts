/**
 * Where the project goes, decided before the first question is asked.
 *
 * The design gives three cases and one rule: create the location if it is
 * missing, set up a new project if it is empty, and treat whatever is already
 * there as the starting point. Once written, a generated project is an ordinary
 * repository and Interfacer has no claim on it between runs — pointing
 * Interfacer at it again puts it back under Interfacer's authority, which is
 * why an occupied location is a project *update* rather than a refusal.
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export type LocationState =
  /** It was not there, so Interfacer made it. */
  | 'created'
  /** It was there and held nothing. A new project. */
  | 'empty'
  /** It holds something. Whatever is there is the starting point. */
  | 'occupied';

export interface Location {
  readonly path: string;
  readonly state: LocationState;
}

export class BadProjectName extends Error {
  constructor(name: string, why: string) {
    super(`project name ${JSON.stringify(name)} ${why}`);
    this.name = new.target.name;
  }
}

/**
 * Resolve `<root>/<project-name>`, creating it where it does not exist.
 *
 * The name is a single directory name and not a path: it names both the
 * directory and the capability, and a name that traverses out of the root is
 * neither.
 */
export function resolveLocation(root: string, projectName: string): Location {
  if (projectName.trim() === '') {
    throw new BadProjectName(projectName, 'is empty');
  }
  if (projectName.includes('/') || projectName.includes(sep) || isAbsolute(projectName)) {
    throw new BadProjectName(projectName, 'is a path; it has to be a single directory name');
  }
  if (projectName === '.' || projectName === '..') {
    throw new BadProjectName(projectName, 'is not a directory name');
  }

  const path = resolve(join(root, projectName));

  let held: readonly string[];
  try {
    held = readdirSync(path);
  } catch {
    mkdirSync(path, { recursive: true });
    return { path, state: 'created' };
  }

  if (!statSync(path).isDirectory()) {
    throw new BadProjectName(projectName, 'is a file');
  }

  return { path, state: held.length === 0 ? 'empty' : 'occupied' };
}

/**
 * The capability id a project name suggests.
 *
 * A proposal, not a decision: the interview settles the capability like every
 * other answer. It has to be a plain identifier because it names the master
 * function a caller imports, so a name that cannot become one yields nothing
 * and the question gets asked.
 */
export function capabilityFrom(projectName: string): string | undefined {
  const parts = projectName.split(/[^A-Za-z0-9_$]+/).filter((part) => part !== '');
  if (parts.length === 0) {
    return undefined;
  }

  const [first, ...rest] = parts;
  const joined = [
    first ?? '',
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)),
  ].join('');

  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(joined) ? joined : undefined;
}
