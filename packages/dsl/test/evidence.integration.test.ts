import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startAll, type FixtureBundle } from '@interfacer/fixtures';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_EFFECTS,
  makeSecret,
  fields,
  Flow,
  runFlow,
  text,
  type AttachmentRef,
  type DataClass,
  type Effects,
  type Entry,
  type Resolver,
} from '@interfacer/dsl';

import {
  approvedTransferFlow,
  balanceFlow,
  transferFlow,
  type BalanceInput,
  type TransferInput,
} from './flows.js';

/**
 * What a run is allowed to write down.
 *
 * Two requirements collide here and the tests exist to prove the resolution
 * holds under a real browser: evidence needs a rich signal on failure, and
 * regulated data must never be persisted into logs. Everything below runs a real
 * flow against a real fixture and then reads what actually landed on disk —
 * because a policy that is correct as a pure function and wrong at the capture
 * site would pass `effects.unit.test.ts` and leak anyway.
 */

/** The password. Must appear nowhere, in any class, ever. */
const SECRET_SENTINEL = 's3cret-teller';
/** Observed page data. Whether this may appear is exactly what `dataClasses` decides. */
const OBSERVED_SENTINEL = 'ACC-1001';

let bundle: FixtureBundle;
let browser: Browser;

beforeAll(async () => {
  [bundle, browser] = await Promise.all([startAll(), chromium.launch()]);
}, 60_000);

afterAll(async () => {
  await Promise.all([bundle.closeAll(), browser.close()]);
});

function effectsFor(dataClasses: readonly DataClass[]): Effects {
  return { ...DEFAULT_EFFECTS, dataClasses };
}

function balanceInput(accountRef = OBSERVED_SENTINEL): BalanceInput {
  return {
    url: bundle.fixtures.clean.url,
    username: 'teller1',
    password: makeSecret(SECRET_SENTINEL),
    accountRef,
  };
}

function transferInput(): TransferInput {
  return {
    url: bundle.fixtures.clean.url,
    username: 'teller1',
    password: makeSecret(SECRET_SENTINEL),
    fromRef: OBSERVED_SENTINEL,
    toRef: 'ACC-1002',
    amount: '25.00',
  };
}

interface Captured {
  readonly entries: Entry[];
  readonly dir: string;
  readonly record: (entry: Entry) => void;
}

function capture(): Captured {
  const entries: Entry[] = [];
  return {
    entries,
    dir: mkdtempSync(join(tmpdir(), 'interfacer-evidence-')),
    record: (entry) => {
      entries.push(entry);
    },
  };
}

const RUN = { timeoutMs: 1_500, retries: 1 } as const;

/** Every attachment the run produced, flattened out of the entries that own them. */
function attachmentsOf(entries: readonly Entry[]): readonly AttachmentRef[] {
  return entries.flatMap((entry) => entry.attachments ?? []);
}

const approve: Resolver = () => Promise.resolve(true);

// @covers dataclasses.govern-evidence dataclasses.masking-at-capture-time
describe('the dataClasses matrix, against a real page', () => {
  it('captures a full screenshot and full markup for non-identifying data', async () => {
    // A mutating flow, because `.commit()` is the trigger a happy path reaches.
    const captured = capture();

    const answer = await runFlow(transferFlow(effectsFor(['non-identifying'])), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
      attachmentDir: captured.dir,
    });

    expect(answer).toEqual({ status: 'ok', reference: 'TRF-000417' });

    const attachments = attachmentsOf(captured.entries);
    expect(attachments.map((a) => a.kind).sort()).toEqual(['dom', 'screenshot']);
    expect(attachments.every((a) => a.redaction === 'none')).toBe(true);

    // Full markup: the page's own text is there, which is the point of the class.
    const dom = attachments.find((a) => a.kind === 'dom');
    const html = readFileSync(join(captured.dir, dom?.path ?? ''), 'utf8');
    expect(html).toContain('Transfer complete');
  });

  // @covers dataclasses.masks-values-not-names
  it('masks the screenshot and strips values out of the markup for PII', async () => {
    const captured = capture();

    await runFlow(transferFlow(effectsFor(['PII'])), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
      attachmentDir: captured.dir,
    });

    const attachments = attachmentsOf(captured.entries);
    expect(attachments.map((a) => `${a.kind}:${a.redaction}`).sort()).toEqual([
      'dom:structure-only',
      'screenshot:masked',
    ]);

    const dom = attachments.find((a) => a.kind === 'dom');
    const html = readFileSync(join(captured.dir, dom?.path ?? ''), 'utf8');

    // Structure kept: the element that held the reference is still there, and
    // still identifiable, so "the field was present but empty" stays readable.
    expect(html).toContain('data-testid="reference"');
    // Values stripped: what it held is not.
    expect(html).not.toContain('TRF-000417');
    expect(html).not.toContain(OBSERVED_SENTINEL);
  });

  it('produces no pixels at all for a full PAN or an SSN', async () => {
    const captured = capture();

    await runFlow(transferFlow(effectsFor(['SSN'])), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
      attachmentDir: captured.dir,
    });

    const attachments = attachmentsOf(captured.entries);
    expect(attachments.map((a) => a.kind)).toEqual(['dom']);
    expect(readdirSync(join(captured.dir), { recursive: true }).join(' ')).not.toContain('.png');
  });

  it('actually paints the mask, rather than declaring one', async () => {
    // The pair that makes the previous test mean something: the same page, the
    // same trigger, two classes — and the bytes differ. Playwright paints the
    // mask before encoding, so the unredacted pixels never exist in a buffer.
    async function screenshotBytes(dataClasses: readonly DataClass[]): Promise<number> {
      const captured = capture();
      await runFlow(transferFlow(effectsFor(dataClasses)), transferInput(), {
        ...RUN,
        browser,
        record: captured.record,
        attachmentDir: captured.dir,
      });
      const shot = attachmentsOf(captured.entries).find((a) => a.kind === 'screenshot');
      expect(shot).toBeDefined();
      return shot?.bytes ?? 0;
    }

    const [plain, masked] = await Promise.all([
      screenshotBytes(['non-identifying']),
      screenshotBytes(['PII']),
    ]);

    expect(plain).toBeGreaterThan(0);
    expect(masked).toBeGreaterThan(0);
    expect(masked).not.toBe(plain);
  });

  // @covers dataclasses.governs-recorded-urls
  it('strips observed values out of the URLs the record carries', async () => {
    // The leak this closes: the application puts the account reference in a
    // query string, so a value the run was given reaches the record through a
    // navigation entry without ever passing through a field.
    const strict = capture();
    const open = capture();

    await runFlow(balanceFlow({ effects: effectsFor(['PII']) }), balanceInput(), {
      ...RUN,
      browser,
      record: strict.record,
    });
    await runFlow(balanceFlow({ effects: effectsFor(['non-identifying']) }), balanceInput(), {
      ...RUN,
      browser,
      record: open.record,
    });

    expect(JSON.stringify(strict.entries)).not.toContain(OBSERVED_SENTINEL);
    expect(JSON.stringify(strict.entries)).toContain('?[redacted]');
    // The contrast: a capability that declared it observes nothing identifying
    // gets the URL intact, which is what makes the redaction a decision.
    expect(JSON.stringify(open.entries)).toContain(`ref=${OBSERVED_SENTINEL}`);
  });
});

// @covers secrets.never-reach-the-record
describe('the sentinel scan', () => {
  it('finds the secret nowhere, in any class, in the record or on disk', async () => {
    // A property rather than an example: scan everything the run produced, not a
    // field somebody remembered to check.
    for (const dataClasses of [['non-identifying'], ['PII'], ['SSN']] as const) {
      const captured = capture();

      await runFlow(transferFlow(effectsFor(dataClasses)), transferInput(), {
        ...RUN,
        browser,
        record: captured.record,
        attachmentDir: captured.dir,
      });

      expect(JSON.stringify(captured.entries)).not.toContain(SECRET_SENTINEL);

      for (const file of readdirSync(captured.dir, { recursive: true, encoding: 'utf8' })) {
        const path = join(captured.dir, file);
        if (!file.endsWith('.html')) {
          continue;
        }
        expect(readFileSync(path, 'utf8')).not.toContain(SECRET_SENTINEL);
      }
    }
  }, 40_000);

  it('finds the secret nowhere in a thrown error either', async () => {
    const captured = capture();
    const doomed = balanceFlow({ withOutcomes: false, effects: effectsFor(['PII']) });

    const failure = await runFlow(doomed, balanceInput('ACC-9999'), {
      ...RUN,
      browser,
      record: captured.record,
      attachmentDir: captured.dir,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(
      SECRET_SENTINEL,
    );
  });
});

// @covers record.attachments-on-triggers
describe('attachments happen on triggers and nowhere else', () => {
  it('captures at a hard failure, and at no ordinary step', async () => {
    const captured = capture();
    const doomed = balanceFlow({ withOutcomes: false });

    await runFlow(doomed, balanceInput('ACC-9999'), {
      ...RUN,
      browser,
      record: captured.record,
      attachmentDir: captured.dir,
    }).catch(() => undefined);

    const carrying = captured.entries.filter((entry) => (entry.attachments ?? []).length > 0);
    expect(carrying.map((entry) => entry.kind)).toEqual(['error']);
    expect(attachmentsOf(captured.entries).every((a) => a.trigger === 'hard-failure')).toBe(true);
  });

  it('captures either side of a control transfer, and at the commit', async () => {
    const captured = capture();

    await runFlow(approvedTransferFlow(), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
      attachmentDir: captured.dir,
      resolver: approve,
    });

    const carrying = captured.entries.filter((entry) => (entry.attachments ?? []).length > 0);

    // Exactly the three moments somebody will later want to see the screen — a
    // handoff whose before and after must be evidenced, and the point of no
    // return. Nothing else, out of a flow of fourteen steps.
    expect(carrying.map((entry) => entry.kind)).toEqual([
      'control.transferred',
      'control.returned',
      'effect.performed',
    ]);
    expect([...new Set(attachmentsOf(captured.entries).map((a) => a.trigger))].sort()).toEqual([
      'commit',
      'control-transfer',
    ]);
  });

  it('captures at a hard failure the step cycle never classified', async () => {
    // The `ACC-9999` case above is a `ReplayError`: the step cycle classified
    // it, so it goes out through `hardFailure` and is evidenced. An error the
    // cycle never classified — a result mapper that throws, a browser that
    // dies, an OOM — reaches `failedWith` instead, and that is the path where
    // evidence matters most: replay is headless, so the attachment is the only
    // account of the screen that will ever exist.
    const captured = capture();

    const broken = new Flow({ id: 'brokenResult', input: fields({ url: text() }) })
      .open((i) => i.url, { id: 'open' })
      .returns(() => {
        throw new Error('the result mapper threw');
      });

    await runFlow(
      broken,
      { url: bundle.fixtures.clean.url },
      {
        ...RUN,
        browser,
        record: captured.record,
        attachmentDir: captured.dir,
      },
    ).catch(() => undefined);

    const failure = captured.entries.find((entry) => entry.kind === 'error');
    expect(failure?.category).toBe('hard-failure');
    expect(failure?.attachments?.map((a) => a.kind).sort()).toEqual(['dom', 'screenshot']);
  });

  it('says so when there is nowhere to put them', async () => {
    // Rich capture that silently did not happen leaves a reader believing they
    // are looking at everything there was.
    const captured = capture();

    await runFlow(transferFlow(), transferInput(), {
      ...RUN,
      browser,
      record: captured.record,
    });

    const commit = captured.entries.find((entry) => entry.kind === 'effect.performed');
    expect(commit?.attachments).toBeUndefined();
    expect(commit?.attachmentsSkipped).toBe('no attachment directory is configured');
  });
});

// @covers record.effect-links-its-approval
describe('a dangerous step is unmistakable', () => {
  it('names the declared dimension and links the approval that authorized it', async () => {
    const captured = capture();

    await runFlow(
      approvedTransferFlow({ effects: { ...DEFAULT_EFFECTS, reversible: 'no' } }),
      transferInput(),
      {
        ...RUN,
        browser,
        record: captured.record,
        resolver: approve,
      },
    );

    const approval = captured.entries.find(
      (entry) => entry.kind === 'pause' && entry.reason === 'awaiting-decision',
    );
    const performed = captured.entries.find((entry) => entry.kind === 'effect.performed');

    expect(performed).toMatchObject({ dimension: 'reversible', value: 'no' });
    // The link is what turns the declaration from a claim in the contract into
    // something observable after the fact.
    expect(performed?.kind === 'effect.performed' && performed.approvedBySeq).toBe(approval?.seq);
  });

  it('makes a missing approval visible rather than absent', async () => {
    // `transferFlow` commits with no approval pause at all. The entry is still
    // written, and carries `null` — which is how an auditor sees that nothing
    // authorized it, instead of seeing nothing.
    //
    // `compensable` rather than `no`: since phase 6 an irreversible commit no
    // approval precedes is refused before the browser opens, so the unauthorized
    // commit an auditor can still meet is the one the declaration did not
    // require an approval for. `safety.integration.test.ts` covers the refusal.
    const captured = capture();

    await runFlow(
      transferFlow({ ...DEFAULT_EFFECTS, reversible: 'compensable' }),
      transferInput(),
      {
        ...RUN,
        browser,
        record: captured.record,
      },
    );

    const performed = captured.entries.find((entry) => entry.kind === 'effect.performed');

    expect(performed).toBeDefined();
    expect(performed?.kind === 'effect.performed' && performed.approvedBySeq).toBeNull();
  });
});

describe('what the run says about its own declaration', () => {
  it('records the classes, and whether they were declared or defaulted', async () => {
    const declared = capture();
    const defaulted = capture();

    await runFlow(balanceFlow({ effects: effectsFor(['PII']) }), balanceInput(), {
      ...RUN,
      browser,
      record: declared.record,
    });
    await runFlow(balanceFlow(), balanceInput(), { ...RUN, browser, record: defaulted.record });

    expect(declared.entries[0]).toMatchObject({
      kind: 'run.started',
      dataClasses: ['PII'],
      effectsDeclared: true,
    });
    // A capability that declares nothing is treated permissively, so the absence
    // has to be visible — otherwise a reader cannot tell a considered
    // `non-identifying` from a forgotten declaration.
    expect(defaulted.entries[0]).toMatchObject({
      kind: 'run.started',
      dataClasses: ['non-identifying'],
      effectsDeclared: false,
    });
  });

  it('keeps the whole record off stdout when a destination is configured', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'interfacer-evidence-')), 'run.jsonl');
    const onStdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      onStdout.push(chunk);
      return true;
    };

    try {
      await runFlow(balanceFlow(), balanceInput(), { ...RUN, browser, destination: { file } });
    } finally {
      process.stdout.write = original;
    }

    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect((JSON.parse(lines[0] ?? '{}') as Entry).kind).toBe('run.started');
    expect(onStdout).toEqual([]);
  });
});
