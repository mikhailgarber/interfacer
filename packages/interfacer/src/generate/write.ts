/**
 * Writing the emitted map to disk.
 *
 * Deliberately the whole of the file-system story: generation is a pure function
 * from a flow to a path → contents map, and this is the only part that touches a
 * disk. That is what lets the tests assert on what was emitted rather than on
 * what a directory looks like afterwards.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ProjectFiles } from './project.js';

export async function writeProject(files: ProjectFiles, root: string): Promise<void> {
  for (const [path, contents] of files) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, 'utf8');
  }
}
