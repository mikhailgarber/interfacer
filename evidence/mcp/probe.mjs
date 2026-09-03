// Minimal stdio JSON-RPC client used to produce jsonrpc-exchange.jsonl and
// run-record.jsonl in this directory. A real MCP client (Claude Code, Claude
// Desktop) registers the server with a config entry instead; this is just a
// harness so the exchange is reproducible from the command line.
//
//   PASSWORD=s3cret-teller node probe.mjs <path-to-generated-project>
//
// with the `clean` fixture running (`npm run fixtures`). The server reads
// PASSWORD from its own environment — it is never a tool argument.
import { spawn } from 'node:child_process';

const project = process.argv[2];
if (!project) throw new Error('usage: PASSWORD=… node probe.mjs <project-dir>');

const srv = spawn('node', [project + '/dist/mcp.js'], {
  env: process.env, // PASSWORD passed through from the caller's environment
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => process.stderr.write(String(d))); // the run record

const send = (o) => srv.stdin.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
await wait(500);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
await wait(200);
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
await wait(500);
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'balanceLookup', arguments: { url: 'http://127.0.0.1:4001', username: 'teller1', accountNumber: 'ACC-1001' } } });
await wait(8000);
srv.kill();

console.log(out); // the JSON-RPC responses, one per line
