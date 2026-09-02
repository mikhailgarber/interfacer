import { field, fields, Flow, literal, text } from '@interfacer/dsl';
import { deadNavigations } from 'interfacer';
import { describe, expect, it } from 'vitest';

/**
 * A step every replay pays for and nothing depends on.
 *
 * Deterministic, which is what makes it worth having: every other guard against
 * a model recording the wrong thing depends on the model complying, and this
 * one is a property of the finished flow.
 */

const input = fields({ url: text(), companyName: text() });

function opened(...steps: readonly string[]) {
  let flow = new Flow({ id: 'linkedinCompany', input });
  for (const [index, step] of steps.entries()) {
    flow =
      step === 'open'
        ? flow.open(field('url'), { id: `open#${String(index)}` })
        : flow.checkpoint([{ by: 'role', role: 'heading', name: 'x' }], {
            id: `checkpoint#${String(index)}`,
          });
  }
  return flow;
}

// @covers generation.reports-a-dead-navigation
describe('a navigation nothing depends on', () => {
  it('is named when one open is immediately followed by another', () => {
    // The shape a live run produced: the search results were opened and then
    // navigated away from without being read, so the page that defined a
    // declared outcome was never on screen to be detected.
    expect(deadNavigations(opened('open', 'open', 'checkpoint').steps)).toEqual(['open#0']);
  });

  it('names every one of them, not just the first', () => {
    expect(deadNavigations(opened('open', 'open', 'open').steps)).toEqual(['open#0', 'open#1']);
  });

  it('says nothing about a navigation whose page is then used', () => {
    expect(deadNavigations(opened('open', 'checkpoint', 'open', 'checkpoint').steps)).toEqual([]);
  });

  it('says nothing about a flow that never navigates twice', () => {
    expect(deadNavigations(opened('open', 'checkpoint').steps)).toEqual([]);
  });
});

describe('the shape the live run actually produced', () => {
  it('catches both the abandoned search and the hardcoded login hop', () => {
    // `open(url)` → `open("…/login")` → … → `open(search)` → `open(company)`:
    // the first and third pages were never acted on.
    const flow = new Flow({ id: 'linkedinCompany', input })
      .open(field('url'), { id: 'open' })
      .open(literal('https://www.linkedin.com/login'), { id: 'open#2' })
      .checkpoint([{ by: 'role', role: 'navigation' }], { id: 'signed-in' })
      .open(field('companyName'), { id: 'open#3' })
      .open(field('companyName'), { id: 'open#4' });

    expect(deadNavigations(flow.steps)).toEqual(['open', 'open#3']);
  });
});
