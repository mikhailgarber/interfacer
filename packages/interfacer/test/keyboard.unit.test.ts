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

describe('the prompt that says whose turn it is', () => {
  it('survives readline redrawing the line, instead of being erased by it', async () => {
    // The bug this guards, from a captured session: the prompt was written
    // straight to the output while readline was handed an empty one, so
    // readline's own redraw — `ESC[1G` to column one, `ESC[0J` to erase — wiped
    // it before the person saw it. Every non-secret question was affected, and
    // the confirmation for a guardrail looked like no question at all.
    const input = new PassThrough();
    const output = new PassThrough();
    const written = capture(output);
    const reader = keyboard(input, output);

    const answered = reader.ask({ kind: 'confirm', text: 'allowlist: mybank.com' });
    input.write('yes\n');
    expect(await answered).toBe('yes');

    const out = written();
    expect(out).toContain('accept? [y/N]');

    // The assertion that distinguishes written-then-erased from redrawn: the
    // prompt has to come *after* the last erase, not before it.
    expect(out.lastIndexOf('\u001b[0J')).toBeLessThan(out.lastIndexOf('accept? [y/N]'));
    reader.close();
  });

  it('does the same for an open question', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written = capture(output);
    const reader = keyboard(input, output);

    const answered = reader.ask({ kind: 'open', text: 'what does this task do?' });
    input.write('reads a balance\n');
    expect(await answered).toBe('reads a balance');

    const out = written();
    expect(out.lastIndexOf('\u001b[0J')).toBeLessThan(out.lastIndexOf('> '));
    reader.close();
  });

  it('still shows the prompt for a secret, where the echo is suppressed', async () => {
    // readline's copy of the prompt goes out through the same stream as the
    // echo, so for a secret it is suppressed with it — and a password prompt
    // showing nothing at all is the one case that must not regress.
    const input = new PassThrough();
    const output = new PassThrough();
    const written = capture(output);
    const reader = keyboard(input, output);

    const answered = reader.ask({ kind: 'open', text: 'the password', secret: true });
    input.write('s3cret-teller\n');
    expect(await answered).toBe('s3cret-teller');

    expect(written()).toContain('> ');
    expect(written()).not.toContain('s3cret-teller');
    reader.close();
  });

  it('sets a question off from the answer above it', async () => {
    // Four lines of prose ending in two characters is a weak signal that it is
    // somebody's turn; a blank line is the cheapest separation there is.
    const input = new PassThrough();
    const output = new PassThrough();
    const written = capture(output);
    const reader = keyboard(input, output);

    const answered = reader.ask({ kind: 'open', text: 'what does this task do?' });
    input.write('reads a balance\n');
    await answered;

    expect(written().startsWith('\nwhat does this task do?')).toBe(true);
    reader.close();
  });
});
