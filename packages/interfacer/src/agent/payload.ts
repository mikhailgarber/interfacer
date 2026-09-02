/**
 * What a rejected request is allowed to say about itself.
 *
 * A provider rejects a malformed request by index and nothing else —
 * `messages.8: user messages must have non-empty content` — and by the time
 * that surfaces, the array it names has already gone out of scope. So the shape
 * of the request travels with the error: enough to say what message 8 was,
 * carried in the error the run record already writes down.
 *
 * The shape and the content are separated on purpose. These messages hold the
 * page's accessibility tree and the live values a person typed during
 * discovery, and the design keeps both out of the record — so the summary
 * reports block kinds and byte counts and never a byte of what was in them.
 * The full request is available, but only where an operator asked for it by
 * name and only on a failure.
 *
 * Deliberately provider-neutral, and deliberately not in `decide.ts`: that
 * module is the one place the SDK is imported, and a diagnostic does not need
 * to be the second. The types below are the structural minimum an SDK request
 * satisfies anyway.
 */
import { writeFileSync } from 'node:fs';

/** The env var that names a file for the full request. Absent means no dump. */
export const DEBUG_PAYLOAD = 'INTERFACER_DEBUG_PAYLOAD';

// Structurally minimal: a real request carries far more than this reads, and
// the point is to describe whatever turns up rather than to restate a
// provider's schema. Only the fields the summary actually reports are named,
// and each is optional so that every block kind satisfies it — an index
// signature would be the obvious alternative, but interfaces never satisfy
// one, so the SDK's own types would stop assigning.
interface Block {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly content?: unknown;
}

interface MessageShape {
  readonly role: string;
  readonly content: string | readonly Block[];
}

export interface RequestShape {
  readonly messages: readonly MessageShape[];
}

function bytes(text: string): string {
  return `${String(Buffer.byteLength(text, 'utf8'))}B`;
}

/**
 * One block, by kind and size.
 *
 * `empty` is spelled out rather than left as `0B` because that is the word the
 * provider's own rejection uses, and a reader matching the two should not have
 * to translate.
 */
function describeBlock(block: Block): string {
  switch (block.type) {
    case 'text': {
      const text = block.text ?? '';
      return text === '' ? 'text, empty' : `text ${bytes(text)}`;
    }
    case 'tool_use':
      return `tool_use(${block.name ?? 'unnamed'})`;
    case 'tool_result': {
      const held = block.content;
      if (typeof held === 'string') {
        return held === '' ? 'tool_result, empty' : `tool_result ${bytes(held)}`;
      }
      if (Array.isArray(held)) {
        return held.length === 0
          ? 'tool_result, empty'
          : `tool_result ${String(held.length)} blocks`;
      }
      return 'tool_result, empty';
    }
    default:
      return block.type;
  }
}

function shapeOf(content: string | readonly Block[]): string {
  if (typeof content === 'string') {
    return content === '' ? 'text, empty' : `text ${bytes(content)}`;
  }
  if (content.length === 0) {
    return 'no content blocks, empty';
  }
  return content.map(describeBlock).join(', ');
}

/** The request's shape, one line per message, indexed as the provider indexes it. */
export function describeRequest(request: RequestShape): string {
  return [
    `the request carried ${String(request.messages.length)} messages:`,
    ...request.messages.map(
      (message, index) =>
        `  [${String(index)}] ${message.role.padEnd(9)} ${shapeOf(message.content)}`,
    ),
  ].join('\n');
}

/**
 * The whole request, where an operator asked for it by name.
 *
 * Opt-in through {@link DEBUG_PAYLOAD}, written only on a failure, to a path
 * the operator chose — because this is the one artifact that holds what the
 * record is careful not to keep, and nobody should acquire it by accident.
 * A dump that fails is reported rather than thrown: turning a diagnosable
 * failure into a different, less diagnosable one is the opposite of the point.
 */
export function dumpRequest(request: RequestShape): string | undefined {
  const path = process.env[DEBUG_PAYLOAD];
  if (path === undefined || path === '') {
    return undefined;
  }
  try {
    writeFileSync(path, JSON.stringify(request, null, 2));
    return `the full request was written to ${path} — it holds live values and page content, so treat it as sensitive`;
  } catch (error) {
    return `the full request could not be written to ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * The whole response, where a turn came back with nothing to act on.
 *
 * Written beside the request dump, under the same opt-in, and for the same
 * reason: a turn that called no tool is the one that ends a session, and
 * knowing what we *sent* while being blind to what came *back* leaves the next
 * diagnosis exactly where the last one was. The content is the model's
 * reasoning about a live page, so this is as sensitive as the request dump.
 */
export function dumpResponse(response: unknown): string | undefined {
  const path = process.env[DEBUG_PAYLOAD];
  if (path === undefined || path === '') {
    return undefined;
  }
  const beside = path.replace(/(\.json)?$/u, '.response.json');
  try {
    writeFileSync(beside, JSON.stringify(response, null, 2));
    return `response written to ${beside}`;
  } catch (error) {
    return `response could not be written to ${beside}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
