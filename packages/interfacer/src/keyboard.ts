/**
 * The person at the keyboard, for the length of a session.
 *
 * One reader rather than one per question, for two reasons a live run showed.
 * A credential typed at a discovery prompt is a real credential — the design
 * says the redaction that applies to it at replay applies here — and readline
 * echoes what it reads, so a password appeared on screen and in scrollback.
 * And a reader per question leaves the input stream held after the last answer:
 * a session driven with a pipe that stays open ran to the end, printed its
 * summary and never exited, because nothing released stdin.
 *
 * Both are properties of the reader rather than of the conversation, which is
 * why this is a module of its own and not four lines inside the CLI.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import type { Ask } from './ask.js';

export interface Keyboard {
  readonly ask: Ask;
  /**
   * Release the input, so a command whose work is done can end.
   *
   * The reader that mattered is the one this closes: a session that made a new
   * reader per question left them stacked on the same stream, which both
   * double-echoed every keystroke and kept the process alive on a stdin nobody
   * would ever close. Pausing as well is belt and braces, and says the intent.
   */
  close(): void;
}

/**
 * Read answers from `input`, writing prompts to `output`.
 *
 * The streams are parameters rather than `process.stdin`/`process.stderr` so
 * that the two properties above are testable against a pair of ordinary streams
 * — a fake, not a mock: the assertions are about what was written and what was
 * left holding the input.
 */
export function keyboard(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Keyboard {
  let hidden = false;
  let closed = false;

  // readline echoes what it reads, and the prompt goes out the same way. The
  // prompt is written to the real output directly and only the echo passes
  // through here, so hiding an answer does not also hide the question.
  const echo = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!hidden) {
        output.write(chunk);
      }
      done();
    },
  });

  const reader = createInterface({ input, output: echo, terminal: true });

  const ask: Ask = async (question) => {
    const marker = question.kind === 'confirm' ? '  accept? [y/N] ' : '> ';

    // The question is written directly and the marker is handed to readline,
    // which is the whole of the fix for a prompt nobody could see. readline
    // redraws its line on every keystroke — `ESC[1G` to column one, then
    // `ESC[0J` to erase — so a marker written behind its back is wiped before
    // anyone reads it, and it was: a captured session showed the guardrail
    // confirmation arriving as a bare statement with no visible question. Given
    // the marker, readline redraws *it* and it survives.
    //
    // A blank line first, because the questions run to several lines of prose
    // and two characters at the end of one is a weak signal that it is somebody
    // else's turn.
    output.write(`\n${question.text}\n`);

    // For a secret the marker has to be written here instead: readline sends
    // its copy through the same stream as the echo, so suppressing one
    // suppresses the other, and a password prompt showing nothing at all is
    // worse than the echo it was protecting against.
    if (question.secret === true) {
      output.write(marker);
    }

    hidden = question.secret === true;
    const answered = await new Promise<string>((accept) => {
      reader.question(hidden ? '' : marker, accept);
    });

    if (hidden) {
      hidden = false;
      // The newline the echo would have carried. Without it the next prompt
      // lands on the same line as the invisible answer.
      output.write('\n');
    }

    return answered.trim();
  };

  return {
    ask,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      reader.close();
      input.pause();
    },
  };
}
