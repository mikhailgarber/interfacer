import { describe, expect, it } from 'vitest';

import { messagesFor, type DiscoveryState, type Exchange } from '../src/agent/decide.js';

/**
 * The shapes a conversation must never be rendered into.
 *
 * A provider rejects a message with no content, and the transcript that
 * produces one comes from a model turn that called nothing — rare enough that
 * no live run is a reliable way to reach it, and fatal for the rest of the
 * session once it is in the transcript. So it is asserted here, at the only
 * place the rendering happens.
 */

const OBSERVATION = {
  url: 'http://127.0.0.1:4001/login',
  title: 'Meridian Bank',
  tree: '- textbox "Username"',
  values: '',
};

function stateWith(transcript: readonly Exchange[]): DiscoveryState {
  return {
    task: 'look up a balance',
    contract: {
      capability: 'balanceLookup',
      inputNames: ['url', 'username'],
      outcomes: [],
      allowlist: ['127.0.0.1:4001'],
    },
    observation: OBSERVATION,
    transcript,
    budget: { capUsd: 5, spentUsd: 0.1 },
  };
}

/** Every message the provider would reject out of hand. */
function empties(
  messages: readonly { role: string; content: string | readonly unknown[] }[],
): number[] {
  return messages.flatMap((message, index) => {
    const { content } = message;
    const empty = typeof content === 'string' ? content === '' : content.length === 0;
    return empty ? [index] : [];
  });
}

describe('rendering a transcript into messages', () => {
  it('never renders a message with no content, whatever the turn produced', () => {
    // The turn at the heart of the failure: the model returned thinking and
    // nothing else, so there is no text, no tool call, and no result to report.
    const transcript: Exchange[] = [
      { kind: 'called', text: '', calls: [] },
      { kind: 'nudge', text: 'you made no tool call' },
    ];

    expect(empties(messagesFor(stateWith(transcript)))).toEqual([]);
  });

  it('replays the thinking that produced a tool call, alongside it', () => {
    // Adaptive thinking is on, so an assistant turn replayed without its
    // thinking is malformed for the mode the request runs in.
    const transcript: Exchange[] = [
      {
        kind: 'called',
        text: '',
        calls: [{ id: 't1', name: 'open', input: {} }],
        reasoning: [{ kind: 'thinking', thinking: 'the entry point first', signature: 'sig-1' }],
      },
      { kind: 'results', results: [{ id: 't1', ok: true, detail: 'open done' }] },
    ];

    const assistant = messagesFor(stateWith(transcript))[1];
    const content = assistant?.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as { type: string; signature?: string }[];

    // First, and with its signature intact: the provider verifies both.
    expect(blocks[0]?.type).toBe('thinking');
    expect(blocks[0]?.signature).toBe('sig-1');
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
  });

  it('renders a nudge as a plain user message', () => {
    const transcript: Exchange[] = [
      { kind: 'called', text: 'thinking out loud', calls: [] },
      { kind: 'nudge', text: 'you made no tool call; call one to proceed' },
    ];

    const messages = messagesFor(stateWith(transcript));
    const nudge = messages.find(
      (m) => m.role === 'user' && m.content === 'you made no tool call; call one to proceed',
    );
    expect(nudge).toBeDefined();
  });
});
