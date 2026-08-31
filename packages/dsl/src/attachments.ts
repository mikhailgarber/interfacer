/**
 * Attachments: the screenshot and DOM snapshot hung off a record entry.
 *
 * Rich capture is expensive and sensitive, so it happens on **triggers** rather
 * than continuously — a hard failure, a control transfer, and the `.commit()`
 * step. Those are the three moments where somebody will later want to see the
 * screen: a failure that must be diagnosed, a handoff whose before and after
 * must be evidenced, and the point of no return.
 *
 * What may be captured is `dataClasses`, and the redaction happens **at capture
 * time** rather than before writing, so an unredacted artifact never exists in a
 * buffer or a temp file. That is why the DOM is stripped inside the page rather
 * than fetched with `page.content()` and cleaned up in Node: the moment the full
 * markup crosses into this process it has been captured, whatever happens to it
 * next.
 *
 * An attachment is referenced from its entry, never inlined, and is written only
 * where a directory has been configured to hold it. Where none is, capture is
 * skipped and the record says so, rather than silently producing less than the
 * reader expects.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Page } from 'playwright';

import { STRUCTURAL_ATTRIBUTES, VALUE_BEARING, type EvidencePolicy } from './effects.js';

/** The three moments rich capture happens, and nothing else. */
export type AttachmentTrigger = 'hard-failure' | 'control-transfer' | 'commit';

export type AttachmentKind = 'screenshot' | 'dom';

/** A reference, not a payload. The record stays a stream of one-line entries. */
export interface AttachmentRef {
  readonly kind: AttachmentKind;
  readonly trigger: AttachmentTrigger;
  /** Relative to the configured directory, so a record survives the tree moving. */
  readonly path: string;
  readonly bytes: number;
  /** How `dataClasses` treated it, so a reader knows what they are looking at. */
  readonly redaction: 'none' | 'masked' | 'structure-only';
}

export interface CaptureRequest {
  readonly page: Page;
  readonly dir: string;
  readonly runId: string;
  /** The `seq` of the entry the attachments hang off. Makes the filename unique. */
  readonly seq: number;
  readonly trigger: AttachmentTrigger;
  readonly policy: EvidencePolicy;
}

/**
 * The in-page serializer, as source.
 *
 * It is a string rather than a function because the package compiles against
 * `lib: ["ES2023"]` with no DOM: giving this module `document` and `Element` as
 * ambient globals would hand them to every other module in the package too,
 * where they are meaningless and where autocompleting `window` is a way to write
 * a bug. The allowlist is inlined by `JSON.stringify`, which is safe because it
 * is a constant in this codebase and never anything a page supplied.
 *
 * It emits element structure and nothing else: no text nodes, and only the
 * attributes that carry a control's *name*. `value`, `placeholder`, `alt`,
 * `title`, `href` and `src` are all absent, because each is somewhere an
 * application puts data it was given.
 */
function structuralSnapshotSource(allowed: readonly string[]): string {
  return `(() => {
    const allowed = new Set(${JSON.stringify(allowed)});
    const serialize = (el) => {
      const attrs = [];
      for (const name of el.getAttributeNames()) {
        if (allowed.has(name)) attrs.push(' ' + name + '="' + el.getAttribute(name) + '"');
      }
      const tag = el.tagName.toLowerCase();
      const kids = [];
      for (const child of el.children) kids.push(serialize(child));
      return '<' + tag + attrs.join('') + '>' + kids.join('') + '</' + tag + '>';
    };
    return serialize(document.documentElement);
  })()`;
}

async function write(dir: string, relative: string, body: string | Uint8Array): Promise<number> {
  const full = join(dir, relative);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body);
  return typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
}

/**
 * Capture what the policy permits, and nothing more.
 *
 * Returns the references to hang off the entry. A policy permitting neither
 * artifact returns nothing, which is a legitimate outcome rather than a failure:
 * `full-PAN` and `SSN` get no pixels by design.
 */
export async function capture(request: CaptureRequest): Promise<readonly AttachmentRef[]> {
  const { page, dir, runId, seq, trigger, policy } = request;
  const refs: AttachmentRef[] = [];
  const base = `${runId}/${String(seq).padStart(4, '0')}-${trigger}`;

  if (policy.screenshot !== 'none') {
    const masked = policy.screenshot === 'masked';
    // Playwright paints the mask before encoding, so the unredacted pixels never
    // exist — which is the whole reason this is the mask option and not a crop
    // applied afterwards.
    const png = await page.screenshot(masked ? { mask: [page.locator(VALUE_BEARING)] } : {});
    const path = `${base}.png`;
    refs.push({
      kind: 'screenshot',
      trigger,
      path,
      bytes: await write(dir, path, png),
      redaction: masked ? 'masked' : 'none',
    });
  }

  const structural = policy.dom === 'structure-only';
  const html = structural
    ? await page.evaluate<string>(structuralSnapshotSource(STRUCTURAL_ATTRIBUTES))
    : await page.content();
  const path = `${base}.html`;
  refs.push({
    kind: 'dom',
    trigger,
    path,
    bytes: await write(dir, path, html),
    redaction: structural ? 'structure-only' : 'none',
  });

  return refs;
}
