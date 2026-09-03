# evidence

One capability, `balanceLookup`, taken end to end: discovered by a live model
driving a fixture, emitted as a project, then replayed deterministically with no
model — success, a business outcome, and hard failures — and invoked once over
MCP.

```
artifact/     the generated capability (source), the thing discovery produced
discovery/    the run record from the live-model discovery session, plus attachments
replay/       five deterministic replays of the artifact, records + stdout/stderr
mcp/          the same capability invoked as an MCP tool over stdio
```

## the goal

Sign in to a bank back-office app and look up a customer account by its number,
returning the balance. Two business outcomes were declared in the interview:
`account_not_found` and `sign_in_rejected`. (The record keeps *which* fields each
turn settled and on whose authority — `discovery/run.jsonl`, `answer.recorded` —
not the words that were said.)

Target: the repo's `clean` fixture (`npm run fixtures`, `http://127.0.0.1:4001`).
Sign-in `teller1` / `s3cret-teller`; `ACC-1001` exists, `ACC-9999` does not.

## what the run shows

`discovery/run.jsonl` is a genuine live-model discovery session: a real browser,
the `clean` fixture, and the model driving the task one step at a time. The
`artifact/` it produced replays deterministically with no model — the `replay/`
and `mcp/` records prove that, and were produced against the committed artifact.

Two honest gaps the record shows, both worth reading:

- **`sign_in_rejected` was never verified.** Provoking it needs deliberately
  wrong credentials, which the model refused as credential-testing
  (`discovery/run.jsonl`, run `…rexl8y79dc`: `model.turn` … `refused (cyber)`,
  then `outcome.undetected`). Interfacer reported it unverified rather than
  recording a guess, and captured the screen a person would need to write the
  detector by hand — `discovery/attachments/…rexl8y79dc/0020-undetected-outcome.*`.
  The emitted artifact has **no `sign_in_rejected` arm** as a result.
- **The `account_not_found` detector over-matches.** Its chain includes a bare
  `byRole('alert')`, so it fires on any page with an alert — including the
  sign-in-error page and an app-error page. `replay/05-misdetection-bad-credentials`
  shows a wrong password coming back as `account_not_found` instead of a hard
  failure. This is a detector-quality problem, not an engine one: the fix is a
  tighter detector (a named alert, or the not-found heading only), and it is the
  kind of thing a human reviewer of the artifact catches before approval.

## artifact/

The generated project's source — `src/flow.ts` is the capability, read top to
bottom. `src/contract.ts` is the typed contract (`fields()` → `Input`; the
result union is inferred from the flow). `src/{cli,index,mcp}.ts` are the three
surfaces over one master function. `src/variant.ts` is the provenance stamp.

As emitted the project also contains `vendor/interfacer-dsl/` (the built DSL, so
it builds standalone) and, after `npm install`, `node_modules/`. Both are
omitted here; `package.json` and `tsconfig.json` are kept.

Effects: `mutates: read`, `dataClasses: ['PII']` — so replay attachments are
masked and DOM snapshots keep structure only (visible in the samples below).

## discovery/

`run.jsonl` — one record for the whole session: the interview (18 `model.turn`,
8 `answer.recorded`, 2 `proposal.put` for the allowlist and `securityEffect`),
then four discovery runs on the engine:

| run (id tail) | what it did | ended |
| --- | --- | --- |
| `…t0hrcdq3` | discover the happy-path flow | success |
| `…hzzl6kn1` | provoke `account_not_found` | success — detector recorded |
| `…rexl8y79dc` | provoke `sign_in_rejected` | **undetected-outcome** — see above |
| `…903ss6t1` | re-confirm `account_not_found` | success |

`attachments/` — the two screenshot + DOM-snapshot pairs the run's triggers
produced: a hard failure during the `account_not_found` provoke, and the
undetected `sign_in_rejected` state.

## replay/

Each `NN-name.record.jsonl` is the run record; `.stdout.json` is what the caller
received; `.stderr.txt` is the thrown error where there was one. All against
`clean` on `127.0.0.1:4001`, no model.

| # | input | result | exit |
| --- | --- | --- | --- |
| 01 | `ACC-1001` | `{ status: "success", balance: 1250.75 }` | 0 |
| 02 | `ACC-9999` | `{ status: "account_not_found" }` — a declared outcome, returned not thrown | 0 |
| 03 | entry point unreachable (dead port) | `SurfaceUnavailable` at step `open` — expected/observed/runId on stderr | 1 |
| 04 | `?_fx=dialog` (an unexpected modal blocks the sign-in click) | `CheckpointFailed` at `pressButton "Sign in"`, after one retry | 1 |
| 05 | wrong password | `account_not_found` — **misdetection**, see gaps above | 0 |

`04` is the richest failure: its record carries the `retry`, the `error`
(category / expected / observed), and an `attachments` entry with
`redaction: "masked"` (screenshot) and `redaction: "structure-only"` (DOM). The
snapshot in `attachments/…/0011-hard-failure.html` shows the injected
`<div role="dialog">` and every text node stripped — `dataClasses: PII` in
effect. Recorded URLs in that run read `…/?[redacted]`.

Reproduce (with `npm run fixtures` running):

```sh
cd <generated-project>
npm install && npm run build
PASSWORD=s3cret-teller node dist/cli.js \
  --url http://127.0.0.1:4001 --username teller1 --account-number ACC-1001
PASSWORD=s3cret-teller node dist/cli.js \
  --url http://127.0.0.1:4001 --username teller1 --account-number ACC-9999
PASSWORD=s3cret-teller node dist/cli.js \
  --url 'http://127.0.0.1:4001/?_fx=dialog' --username teller1 --account-number ACC-1001
```

## mcp/

`jsonrpc-exchange.jsonl` — three responses from the generated stdio MCP server:

- `initialize` → `serverInfo { name: "balanceLookup", version: "0.1.0" }`
- `tools/list` → one tool. `password` is **absent** from `inputSchema` (a
  `secret()` field); the `effects` line is in the description; `outputSchema` is
  a `oneOf` of the two declared answers.
- `tools/call` with `{ url, username, accountNumber }` → `structuredContent`
  `{ status: "success", accountNumber: "ACC-1001", balance: 1250.75 }`.

`run-record.jsonl` — the engine record from that call. The server read `PASSWORD`
from its own environment; the record shows `secretInputNames: ["password"]` and
no value. A business outcome would return as a normal result; only a hard failure
sets `isError`.

`probe.mjs` — the throwaway stdio client that produced the two files above, so
the exchange is reproducible: `PASSWORD=s3cret-teller node probe.mjs <project>`
with the fixtures running. A real MCP client registers the server by config
instead.

## a note on redaction

Every file here was scanned for the fixture credentials, the sign-in values, and
any real identifiers before it was committed. Screenshots are masked and DOM
snapshots are structure-only because the capability declares `dataClasses: PII`;
`Secret` keeps the password out of every record structurally.
