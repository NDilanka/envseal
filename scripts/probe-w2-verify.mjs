// W2 · env_verify against a REAL HTTPS server that echoes the credential.
//
// PLAN §5.1 on env_verify: "Never returns the upstream response body: providers
// echo credentials in error payloads more often than you would hope."
//
// postman-echo.com is a real HTTPS host that reflects every request header in
// its response body, so it reproduces exactly that provider behaviour without
// needing a locally generated certificate. `verify.ts:31` hard-requires
// https://, so a plain local HTTP server cannot reach the network path at all.
//
// The sentinel below is a fabricated string, not a credential.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/core/dist/index.js';
import { secretFromUtf8 } from '../packages/protocol/dist/index.js';

const SENTINEL = 'sk-W2SENTINEL-verify-4d8e2f0a6b19';

const root = mkdtempSync(join(tmpdir(), 'envseal-w2-verify-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');

const stub = {
  id: 'ide',
  available: async () => true,
  prompt: async (req) => ({
    ticket: req.ticket,
    results: req.keys.map((k) => ({ key: k.key, outcome: 'entered', value: secretFromUtf8(SENTINEL) })),
  }),
  cancel: async () => {},
};

let approvalPrompts = 0;
const broker = new Broker({
  root,
  prompter: stub,
  onApprovalNeeded: async () => {
    approvalPrompts++;
    return true;
  },
});

// A probe whose host echoes every header back, and whose expected status will
// not match, so the "unexpected status" branch runs with a real response in hand.
const probe = {
  method: 'GET',
  url: 'https://postman-echo.com/get',
  headerTemplate: { Authorization: 'Bearer {{value}}', 'X-Api-Key': '{{value}}' },
  expectStatus: [999],
};

await broker.declare({
  entries: [
    { key: 'ECHO_KEY', description: 'W2 verify probe', required: true, secret: true, verify: probe },
  ],
});
const t = await broker.request({ keys: ['ECHO_KEY'], reason: 'W2 verify probe' });
await broker.await({ ticket: t.ticket, timeoutMs: 8000 });

console.log('--- confirm the remote really does echo the credential ---');
const direct = await fetch(probe.url, { headers: { Authorization: `Bearer ${SENTINEL}` } });
const directBody = await direct.text();
console.log(`  direct fetch status=${direct.status} bodyContainsSentinel=${directBody.includes(SENTINEL)}`);

console.log('--- first verify: novel host, approval callback supplied ---');
const r1 = await broker.verify({ keys: ['ECHO_KEY'] });
console.log(`  ${JSON.stringify(r1)}`);
console.log(`  approval callback invoked: ${approvalPrompts} time(s)`);
console.log(`  result leaks sentinel: ${JSON.stringify(r1).includes(SENTINEL)}`);

console.log('--- second verify: approval now recorded, no callback needed ---');
const broker2 = new Broker({ root, prompter: stub });
const r2 = await broker2.verify({ keys: ['ECHO_KEY'] });
console.log(`  ${JSON.stringify(r2)}`);
console.log(`  result leaks sentinel: ${JSON.stringify(r2).includes(SENTINEL)}`);

console.log('--- same host, no approval callback and no recorded approval ---');
const root3 = mkdtempSync(join(tmpdir(), 'envseal-w2-verify2-'));
writeFileSync(join(root3, '.gitignore'), '.env\n', 'utf8');
const broker3 = new Broker({ root: root3, prompter: stub });
await broker3.declare({
  entries: [{ key: 'ECHO_KEY', description: 'x', required: true, secret: true, verify: probe }],
});
const t3 = await broker3.request({ keys: ['ECHO_KEY'], reason: 'x' });
await broker3.await({ ticket: t3.ticket, timeoutMs: 8000 });
const r3 = await broker3.verify({ keys: ['ECHO_KEY'] });
console.log(`  ${JSON.stringify(r3)}`);
console.log(`  -> fail-closed (no probe sent): ${r3[0].result === 'probe_not_approved'}`);

console.log('--- artifact sweep ---');
for (const [label, p] of [
  ['.env (intended sink)', join(root, '.env')],
  ['env.schema.jsonc', join(root, 'env.schema.jsonc')],
  ['.envseal/audit.jsonl', join(root, '.envseal', 'audit.jsonl')],
  ['.envseal/approvals.json', join(root, '.envseal', 'approvals.json')],
]) {
  if (!existsSync(p)) {
    console.log(`  ${label.padEnd(26)} (absent)`);
    continue;
  }
  const s = readFileSync(p, 'utf8');
  console.log(`  ${label.padEnd(26)} sentinel=${s.includes(SENTINEL)}`);
}

broker.dispose();
broker2.dispose();
broker3.dispose();
rmSync(root, { recursive: true, force: true });
rmSync(root3, { recursive: true, force: true });
