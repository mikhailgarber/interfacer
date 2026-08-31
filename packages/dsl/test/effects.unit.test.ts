import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createEmitter,
  createEntryFactory,
  DEFAULT_EFFECTS,
  evidencePolicyFor,
  redactUrl,
  type DataClass,
  type Entry,
  type EvidencePolicy,
} from '@interfacer/dsl';
import { describe, expect, it } from 'vitest';

/**
 * What `dataClasses` permits, and where the record goes — the pure half of the
 * evidence rules.
 *
 * The matrix is a pure function over the declared classes because that is what
 * makes it exhaustively checkable rather than reachable only by driving a
 * browser into each state. It is the same reason `decideVerification` was
 * factored out: a rule that decides what may be written about a person should
 * not be observable only as a side effect.
 */

const FULL: EvidencePolicy = { screenshot: 'full', dom: 'full', urls: 'full' };
const MASKED: EvidencePolicy = { screenshot: 'masked', dom: 'structure-only', urls: 'path-only' };
const STRUCTURAL: EvidencePolicy = { screenshot: 'none', dom: 'structure-only', urls: 'path-only' };

// @covers dataclasses.govern-evidence
describe('the dataClasses matrix', () => {
  it('gives non-identifying data a full screenshot and a full DOM snapshot', () => {
    expect(evidencePolicyFor(['non-identifying'])).toEqual(FULL);
  });

  it('masks the screenshot and strips the DOM for PII', () => {
    expect(evidencePolicyFor(['PII'])).toEqual(MASKED);
  });

  it.each<DataClass>(['full-PAN', 'SSN'])('permits no pixels at all for %s', (klass) => {
    // There is no mask that makes a screenshot of a full card number safe to
    // keep, so the answer is structural evidence and nothing else.
    expect(evidencePolicyFor([klass])).toEqual(STRUCTURAL);
  });

  it('takes the strictest class a capability declares', () => {
    // A capability declaring both observes an SSN, and the balance it also reads
    // does not make that less true.
    expect(evidencePolicyFor(['non-identifying', 'SSN'])).toEqual(STRUCTURAL);
    expect(evidencePolicyFor(['non-identifying', 'PII'])).toEqual(MASKED);
    expect(evidencePolicyFor(['PII', 'full-PAN'])).toEqual(STRUCTURAL);
  });

  it('treats a capability that declares nothing as non-identifying, visibly', () => {
    // Permissive, because a conservative default would silently mask and redact
    // for a capability nobody said handles anything sensitive — and the reader
    // would have no way to tell that from a declaration. The run record says
    // which it was; `evidence.integration.test.ts` asserts that.
    expect(DEFAULT_EFFECTS.dataClasses).toEqual(['non-identifying']);
    expect(evidencePolicyFor(DEFAULT_EFFECTS.dataClasses)).toEqual(FULL);
  });
});

// @covers dataclasses.govern-evidence
describe('redactUrl', () => {
  it('leaves a URL alone where the policy permits it', () => {
    expect(redactUrl('https://bank.example/account?ref=ACC-1001#top', FULL)).toBe(
      'https://bank.example/account?ref=ACC-1001#top',
    );
  });

  it('keeps origin and path, and drops query and fragment', () => {
    // Query and fragment are where an application puts the values it was given.
    // Origin and path stay because a navigation nobody can locate is not
    // evidence.
    expect(redactUrl('https://bank.example/account?ref=ACC-1001', MASKED)).toBe(
      'https://bank.example/account?[redacted]',
    );
    expect(redactUrl('https://bank.example/account#ref-ACC-1001', STRUCTURAL)).toBe(
      'https://bank.example/account?[redacted]',
    );
  });

  it('says nothing was dropped when there was nothing to drop', () => {
    expect(redactUrl('https://bank.example/search', MASKED)).toBe('https://bank.example/search');
  });

  it('keeps the port, which identifies the surface rather than the data', () => {
    expect(redactUrl('http://127.0.0.1:8080/account?ref=X', MASKED)).toBe(
      'http://127.0.0.1:8080/account?[redacted]',
    );
    expect(redactUrl('http://127.0.0.1:8080/search', MASKED)).toBe('http://127.0.0.1:8080/search');
  });

  it('refuses to hand on something unparseable that carries a query', () => {
    // `about:blank` and the like are already free of page data. Anything else
    // this cannot read is not something to pass through on the assumption that
    // it is safe.
    expect(redactUrl('about:blank', MASKED)).toBe('about:blank');
    expect(redactUrl('not a url at all', MASKED)).toBe('not a url at all');
    expect(redactUrl('not a url?ref=ACC-1001', MASKED)).toBe('[redacted]');
  });
});

// @covers record.never-on-mcp-stdout
describe('where the record goes', () => {
  function entriesFor(destination: Parameters<typeof createEmitter>[0]): {
    emit: (entry: Entry) => void;
    entry: () => Entry;
  } {
    const factory = createEntryFactory({
      runId: 'run_1',
      capabilityId: 'cap',
      capabilityVersion: '1.0.0',
      phase: 'replay',
    });
    return {
      emit: createEmitter(destination),
      entry: () => factory.entry({ kind: 'run.finished', status: { ending: 'success' } }),
    };
  }

  it('writes one JSON object per line to a configured file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'interfacer-record-'));
    const file = join(dir, 'nested', 'run.jsonl');
    const { emit, entry } = entriesFor({ file });

    emit(entry());
    emit(entry());

    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as Entry).seq)).toEqual([0, 1]);
  });

  it('keeps stdout clean when the destination is stderr or a file', () => {
    // The MCP constraint, in the only form this tier can state it: an MCP
    // server's stdout is the protocol transport, so a record written there
    // corrupts the protocol rather than merely being untidy. Phase 7 is what
    // binds the server to one of these; this is what makes either honest.
    const dir = mkdtempSync(join(tmpdir(), 'interfacer-record-'));
    const onStdout: string[] = [];
    const onStderr: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const collect =
      (into: string[]): typeof process.stdout.write =>
      (chunk: string) => {
        into.push(chunk);
        return true;
      };

    process.stdout.write = collect(onStdout);
    // Captured too, so the reporter's own output is not interleaved with a
    // record this test deliberately emits.
    process.stderr.write = collect(onStderr);

    try {
      for (const destination of ['stderr', { file: join(dir, 'run.jsonl') }] as const) {
        const { emit, entry } = entriesFor(destination);
        emit(entry());
      }
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }

    expect(onStdout).toEqual([]);
    expect(onStderr).toHaveLength(1);
  });
});
