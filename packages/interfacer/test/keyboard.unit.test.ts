import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { keyboard } from 'interfacer';
import { describe, expect, it } from 'vitest';

/**
 * The reader a session answers through.
 *
 * Both tests here are for behaviour a live run exhibited: a password typed at a
 * discovery prompt appeared on screen, and a session driven through a pipe that
 * stayed open printed its summary and then never exited. The streams are
 * ordinary `PassThrough`s — a fake, not a mock: what is asserted is what was
 * written and whether the input was let go, never how often anything was called.
 */

/** What the output stream received, once the answer has come back. */
function capture(stream: PassThrough): () => string {
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(String(chunk)));
  return () => chunks.join('');
}

describe('an answer that is a credential', () => {
  it('is never echoed, while the question still is', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = capture(output);
    const reader = keyboard(input, output);

    const answered = reader.ask({
      kind: 'open',
      text: 'value for password — the operator password',
      secret: true,
    });
    input.write('s3cret-teller\n');

    expect(await answered).toBe('s3cret-teller');
    // The question has to stay visible: a prompt nobody can read is not a
    // question, and hiding the answer is the whole of what was asked for.
    expect(written()).toContain('value for password');
    expect(written()).not.toContain('s3cret-teller');

    reader.close();
  });

  it('is the only kind hidden — an ordinary answer still shows', async () => {
    // The guard on the fix: a session where nothing echoes reads as a hung
    // terminal, and the person cannot see what they typed or correct it.
    const input = new PassThrough();
    const output = new PassThrough();
    const written = capture(output);
    const reader = keyboard(input, output);

    const answered = reader.ask({ kind: 'open', text: 'value for username' });
    input.write('teller1\n');

    expect(await answered).toBe('teller1');
    expect(written()).toContain('teller1');

    reader.close();
  });
});

describe('a session whose input is a pipe somebody still holds open', () => {
  it('ends when the work does, rather than waiting on a stream nobody is reading', async () => {
    // stdin that never sees EOF is how a terminal behaves and how a driven
    // session behaves. Before this, the reader held it after the last answer:
    // the run finished, printed what it wrote, and the process stayed alive.
    const dir = mkdtempSync(join(tmpdir(), 'interfacer-keyboard-'));
    const script = join(dir, 'session.mjs');
    writeFileSync(
      script,
      [
        `import { keyboard } from ${JSON.stringify(resolve('packages/interfacer/dist/index.js'))};`,
        'const reader = keyboard(process.stdin, process.stderr);',
        "await reader.ask({ kind: 'open', text: 'value for username' });",
        'reader.close();',
        'process.exitCode = 0;',
      ].join('\n'),
    );

    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'ignore', 'ignore'] });
    // Written, never ended: the writer stays open, exactly as a terminal does.
    child.stdin.write('teller1\n');

    const ended = await new Promise<number | 'still running'>((accept) => {
      const waiting = setTimeout(() => {
        accept('still running');
      }, 5_000);
      child.on('exit', (code) => {
        clearTimeout(waiting);
        accept(code ?? -1);
      });
    });

    if (ended === 'still running') {
      child.kill();
    }

    expect(ended).toBe(0);
  }, 10_000);
});
