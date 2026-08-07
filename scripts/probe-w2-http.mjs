// W2 · HTTP binding: hit every route with a value already provisioned in the
// sink, and sweep both the response BODY and every response HEADER.
//
// `startHttpServer` takes no prompter (server.ts:57 constructs the Broker with
// only `root`), so the value is provisioned the way the broker itself would
// leave it — written into the dotenv sink — before the server starts.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { startHttpServer } from '../packages/http-server/dist/server.js';

const SENTINEL = 'sk-W2SENTINEL-http-aaaabbbbccccdddd';
const TOKEN = 'w2-probe-token-0123456789';

const root = mkdtempSync(join(tmpdir(), 'envseal-w2-http-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
writeFileSync(join(root, '.env'), `OPENAI_API_KEY=${SENTINEL}\n`, 'utf8');
writeFileSync(
  join(root, 'env.schema.jsonc'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        {
          key: 'OPENAI_API_KEY',
          description: 'W2 http probe',
          required: true,
          secret: true,
          sink: 'dotenv',
          format: { pattern: '^sk-' },
          verify: {
            method: 'GET',
            url: 'https://api.openai.com/v1/models',
            headerTemplate: { Authorization: 'Bearer {{value}}' },
            expectStatus: [200],
          },
        },
      ],
    },
    null,
    2,
  ),
  'utf8',
);

const server = await startHttpServer({ root, token: TOKEN });
const port = new URL(server.url).port;

const exchanges = [];

function req({ path, method = 'POST', headers = {}, body, rawBody }) {
  return new Promise((resolve) => {
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const h = { ...headers };
    if (payload !== undefined) {
      h['Content-Type'] ??= 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawHeaders: res.rawHeaders.join('\n'),
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, rawHeaders: '', body: `ERR ${e.message}` }));
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

async function shot(label, opts) {
  const res = await req(opts);
  exchanges.push({ label, ...res });
  const inBody = res.body.includes(SENTINEL);
  const inHeaders = res.rawHeaders.includes(SENTINEL);
  console.log(
    `  ${label.padEnd(44)} ${String(res.status).padStart(3)}  body=${String(inBody).padEnd(5)} hdr=${String(inHeaders).padEnd(5)} ${res.body.slice(0, 90).replace(/\s+/g, ' ')}`,
  );
  return res;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

console.log('=== every /v1 route with a value present in the sink ===');
await shot('env_describe', { path: '/v1/env_describe', headers: auth, body: {} });
await shot('env_declare', {
  path: '/v1/env_declare',
  headers: auth,
  body: { entries: [{ key: 'SECOND_KEY', description: 'w2', required: true, secret: true }] },
});
const ticketRes = await shot('env_request', {
  path: '/v1/env_request',
  headers: auth,
  body: { keys: ['OPENAI_API_KEY'], reason: 'w2 http probe' },
});
let ticketId = null;
try {
  ticketId = JSON.parse(ticketRes.body).ticket;
} catch {
  /* request may have errored */
}
await shot('env_await', {
  path: '/v1/env_await',
  headers: auth,
  body: { ticket: ticketId ?? 'none', timeoutMs: 2000 },
});
await shot('env_verify', { path: '/v1/env_verify', headers: auth, body: { keys: ['OPENAI_API_KEY'] } });
await shot('env_use', {
  path: '/v1/env_use',
  headers: auth,
  body: {
    keys: ['OPENAI_API_KEY'],
    command: [process.execPath, '-e', 'console.log(process.env.OPENAI_API_KEY)'],
  },
});
await shot('env_revoke', { path: '/v1/env_revoke', headers: auth, body: { keys: ['OPENAI_API_KEY'] } });
await shot('GET /openapi.json', { path: '/openapi.json', method: 'GET', headers: auth });

console.log('=== error branches ===');
await shot('no Authorization', { path: '/v1/env_describe', body: {} });
await shot('wrong token', { path: '/v1/env_describe', headers: { Authorization: 'Bearer nope' }, body: {} });
await shot('token = the sentinel', {
  path: '/v1/env_describe',
  headers: { Authorization: `Bearer ${SENTINEL}` },
  body: {},
});
await shot('Host: evil.local', { path: '/v1/env_describe', headers: { ...auth, Host: 'evil.local' }, body: {} });
await shot('Origin present', {
  path: '/v1/env_describe',
  headers: { ...auth, Origin: 'https://attacker.example' },
  body: {},
});
await shot('GET on /v1 route', { path: '/v1/env_describe', method: 'GET', headers: auth });
await shot('unknown route', { path: '/v1/env_nope', headers: auth, body: {} });
await shot('path traversal', { path: '/v1/../.env', method: 'GET', headers: auth });
await shot('malformed JSON body', { path: '/v1/env_describe', headers: auth, rawBody: '{not json' });
await shot('body is the sentinel (not JSON)', { path: '/v1/env_describe', headers: auth, rawBody: SENTINEL });
await shot('body over the 1 MiB cap', {
  path: '/v1/env_describe',
  headers: auth,
  rawBody: `{"scope":"${'x'.repeat(1024 * 1024 + 64)}"}`,
});
await shot('schema violation (wrong types)', {
  path: '/v1/env_declare',
  headers: auth,
  body: { entries: [{ key: 123, description: SENTINEL }] },
});
await shot('declare carrying an explicit value field', {
  path: '/v1/env_declare',
  headers: auth,
  body: { entries: [{ key: 'EVIL_KEY', description: 'x', value: SENTINEL }] },
});
// Force the 500 branch: dispatch throws for a broker method that rejects.
await shot('env_await with a bad ticket type (500 branch)', {
  path: '/v1/env_await',
  headers: auth,
  body: { ticket: { nested: SENTINEL }, timeoutMs: 2000 },
});

console.log('=== sweep ===');
let bodyLeaks = 0;
let headerLeaks = 0;
for (const e of exchanges) {
  if (e.body.includes(SENTINEL)) {
    bodyLeaks++;
    console.log(`  BODY LEAK   ${e.label}`);
  }
  if (e.rawHeaders.includes(SENTINEL)) {
    headerLeaks++;
    console.log(`  HEADER LEAK ${e.label}`);
  }
}
console.log(`  exchanges recorded: ${exchanges.length}`);
console.log(`  body leaks:   ${bodyLeaks}`);
console.log(`  header leaks: ${headerLeaks}`);

console.log('  --- on-disk artifacts ---');
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
  console.log(`  ${label.padEnd(26)} sentinel=${readFileSync(p, 'utf8').includes(SENTINEL)}`);
}

await server.close();
rmSync(root, { recursive: true, force: true });
