import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { describeRequest, dumpRequest, dumpResponse } from '../src/agent/payload.js';

/**
 * What a rejected request is allowed to say about itself.
 *
 * A provider rejection names a message index and nothing else — `messages.8:
 * user messages must have non-empty content` — and by the time it surfaces, the
 * array it is about is gone. These prove the shape survives the error, and that
 * the shape alone carries no content: the messages hold the page tree and the
 * live values a person typed during discovery, and neither may reach the record.
 */

const SECRET = 's3cret-teller';
const OBSERVED = 'ACC-1001';

describe('the structural summary of a request', () => {
  it('names the index of a message with no content blocks', () => {
    // Held in a variable rather than written inline: a real request carries
    // far more per block than `RequestShape` names, and a fresh literal would
    // be checked for properties the production caller is allowed to have.
    const messages = [
      { role: 'user', content: 'the brief' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'open', input: {} }] },
      { role: 'user', content: [] },
    ];

    const summary = describeRequest({ messages });

    expect(summary).toContain('[2]');
    expect(summary).toMatch(/\[2\][^\n]*empty/);
    // The messages that were fine are not accused of anything.
    expect(summary).not.toMatch(/\[0\][^\n]*empty/);
    expect(summary).not.toMatch(/\[1\][^\n]*empty/);
  });

  it('names the index of a tool result whose content is an empty string', () => {
    const messages = [
      { role: 'user', content: 'the brief' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] },
    ];

    const summary = describeRequest({ messages });

    expect(summary).toMatch(/\[1\][^\n]*empty/);
  });

  it('reports the shape of every block without reporting what it held', () => {
    const messages = [
      { role: 'user', content: `Current page: ${OBSERVED}` },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'deliberating', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'fillForm', input: { value: SECRET } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: `bound to ${SECRET}` }],
      },
    ];

    const summary = describeRequest({ messages });

    // The shape is all there: roles, block kinds, the tool that was called.
    expect(summary).toContain('assistant');
    expect(summary).toContain('thinking');
    expect(summary).toContain('tool_use(fillForm)');
    expect(summary).toContain('tool_result');

    // The content is not.
    expect(summary).not.toContain(SECRET);
    expect(summary).not.toContain(OBSERVED);
  });
});

describe('the full request dump', () => {
  const made: string[] = [];

  afterEach(() => {
    delete process.env.INTERFACER_DEBUG_PAYLOAD;
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'interfacer-payload-'));
    made.push(dir);
    return join(dir, 'request.json');
  }

  it('writes nothing at all unless the operator named a file', () => {
    expect(dumpRequest({ messages: [{ role: 'user', content: 'the brief' }] })).toBeUndefined();
  });

  it('writes the whole request, content and all, where one is named', () => {
    const path = scratch();
    process.env.INTERFACER_DEBUG_PAYLOAD = path;

    // The whole request, not just its messages — which is the point of the
    // dump, and why it is the artifact that has to be asked for by name.
    const request = {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: `bound to ${SECRET}` }],
    };

    const note = dumpRequest(request);

    expect(note).toContain(path);
    // The operator is told what they now have on disk, because this is the one
    // artifact that holds what the record deliberately does not.
    expect(note).toMatch(/live value|page content/i);

    const written: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(JSON.stringify(written)).toContain(SECRET);
  });

  it('says so rather than throwing when the file cannot be written', () => {
    process.env.INTERFACER_DEBUG_PAYLOAD = '/does/not/exist/request.json';

    // A dump that fails must never turn a diagnosable failure into a different,
    // less diagnosable one.
    expect(() => dumpRequest({ messages: [] })).not.toThrow();
    expect(dumpRequest({ messages: [] })).toContain('could not');
  });
});

describe('the response dump', () => {
  afterEach(() => {
    delete process.env.INTERFACER_DEBUG_PAYLOAD;
  });

  it('writes nothing unless the operator named a file', () => {
    expect(dumpResponse({ stop_reason: 'end_turn' })).toBeUndefined();
  });

  it('writes beside the request, so the pair can be read together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'interfacer-payload-'));
    const path = join(dir, 'request.json');
    process.env.INTERFACER_DEBUG_PAYLOAD = path;

    // Knowing what was sent while being blind to what came back leaves the next
    // diagnosis exactly where the last one was.
    const note = dumpResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking' }] });

    expect(note).toContain('request.response.json');
    const written: unknown = JSON.parse(readFileSync(join(dir, 'request.response.json'), 'utf8'));
    expect(JSON.stringify(written)).toContain('end_turn');
  });
});
