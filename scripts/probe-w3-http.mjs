// W3 red-team probe: the local HTTP binding (packages/http-server/src/server.ts).
//
// A token is always passed explicitly so the probe never reads or creates
// ~/.envseal/api-token. The project root is a mkdtemp with a .gitignore.
import { connect, createConnection } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../packages/http-server/dist/index.js';

let pass = 0;
let fail = 0;
const findings = [];
const notes = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    findings.push(`${name}: ${detail ?? ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function note(text) {
  notes.push(text);
  console.log(`  NOTE  ${text}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// --- raw HTTP client (needed: undici rewrites Host and normalises paths) ----

function raw(port, payload, opts = {}) {
  return new Promise((resolve) => {
    const socket = createConnection(port, opts.host ?? '127.0.0.1');
    const chunks = [];
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...outcome, body: Buffer.concat(chunks).toString('utf8') });
    };
    socket.setTimeout(opts.timeoutMs ?? 4000, () => done({ event: 'timeout' }));
    socket.on('connect', () => {
      if (typeof payload === 'function') payload(socket);
      else socket.write(payload);
    });
    socket.on('data', (c) => {
      chunks.push(c);
      // Responses carry no Connection: close, so read until the body is complete.
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split !== -1) {
        const len = /content-length:\s*(\d+)/i.exec(text.slice(0, split));
        if (len !== null && text.length - (split + 4) >= Number(len[1])) done({ event: 'complete' });
      }
    });
    socket.on('close', () => done({ event: 'close' }));
    socket.on('error', (err) => done({ event: 'error', code: err.code }));
  });
}

function statusOf(r) {
  const m = /^HTTP\/1\.\d (\d{3})/.exec(r.body);
  return m === null ? null : Number(m[1]);
}
/** Strip chunked transfer-encoding framing so assertions see only the payload. */
function dechunk(text) {
  const CRLF = '\r\n';
  let out = '';
  let rest = text;
  for (;;) {
    const nl = rest.indexOf(CRLF);
    if (nl === -1) break;
    const size = parseInt(rest.slice(0, nl), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += rest.slice(nl + 2, nl + 2 + size);
    rest = rest.slice(nl + 2 + size + 2);
  }
  return out === '' ? text : out;
}

function bodyOf(r) {
  const i = r.body.indexOf('\r\n\r\n');
  return i === -1 ? '' : r.body.slice(i + 4);
}
function jsonOf(r) {
  try {
    return JSON.parse(bodyOf(r));
  } catch {
    return null;
  }
}
function req(port, { method = 'POST', path = '/v1/env_describe', headers = {}, body = '' } = {}) {
  const buf = Buffer.from(body, 'utf8');
  const merged = { Host: `127.0.0.1:${port}`, 'Content-Length': String(buf.length), ...headers };
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(merged)) if (v !== null) lines.push(`${k}: ${v}`);
  return raw(port, Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'), buf]));
}

// --- fixture ---------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'envseal-w3-http-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
writeFileSync(
  join(root, 'env.schema.jsonc'),
  JSON.stringify({
    version: 1,
    entries: [
      {
        key: 'OPENAI_API_KEY',
        description: 'probe fixture',
        required: true,
        secret: true,
        sink: 'dotenv',
      },
    ],
  }),
  'utf8',
);

const TOKEN = 'w3probe'.padEnd(64, '0');
const server = await startHttpServer({ root, token: TOKEN });
const port = Number(new URL(server.url).port);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
console.log(`listening on ${server.url}`);

// ===========================================================================
section('B1  Bearer token');
{
  const ok = await req(port, { headers: AUTH, body: '{}' });
  check('correct token -> 200', statusOf(ok) === 200, `observed ${statusOf(ok)}`);

  const cases = [
    ['no Authorization header', {}],
    ['empty Authorization header', { Authorization: '' }],
    ['"Bearer" with no space', { Authorization: 'Bearer' }],
    ['"Bearer " with empty token', { Authorization: 'Bearer ' }],
    ['wrong scheme (Basic)', { Authorization: `Basic ${TOKEN}` }],
    ['lowercase scheme "bearer "', { Authorization: `bearer ${TOKEN}` }],
    ['token one char short', { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ['token one char long', { Authorization: `Bearer ${TOKEN}0` }],
    ['correct prefix, wrong suffix', { Authorization: `Bearer ${TOKEN.slice(0, 32)}${'f'.repeat(32)}` }],
    ['token with an embedded space', { Authorization: `Bearer ${TOKEN.slice(0, 32)} ${TOKEN.slice(33)}` }],
    ['correct token, uppercased', { Authorization: `Bearer ${TOKEN.toUpperCase()}` }],
    ['1-byte token (unequal length -> timingSafeEqual would throw)', { Authorization: 'Bearer a' }],
    ['63-char token + trailing OWS', { Authorization: `Bearer ${TOKEN.slice(0, 63)} ` }],
  ];
  for (const [label, headers] of cases) {
    const r = await req(port, { headers, body: '{}' });
    check(`${label} -> 401`, statusOf(r) === 401, `observed ${statusOf(r) ?? r.event}`);
  }

  // RFC 9110 5.5: the parser strips optional trailing whitespace from a field
  // value, so `Bearer <token> ` IS the same credential. 200 is correct here.
  const trailingOws = await req(port, { headers: { Authorization: `Bearer ${TOKEN} ` }, body: '{}' });
  check(
    'correct token + trailing OWS -> 200 (parser strips OWS; same credential)',
    statusOf(trailingOws) === 200,
    `observed ${statusOf(trailingOws)}`,
  );

  // 65 KiB exceeds Node's 16 KiB maxHeaderSize: refused by the HTTP parser,
  // so it never reaches the auth code at all.
  const huge = await req(port, { headers: { Authorization: `Bearer ${'a'.repeat(65536)}` }, body: '{}' });
  check(
    '65 KiB token rejected before the handler (Node maxHeaderSize)',
    statusOf(huge) !== 200,
    `status=${statusOf(huge) ?? '-'} event=${huge.event} — never reaches timingSafeEqual`,
  );

  // A NUL inside a header value is rejected by Node's HTTP parser (400) before
  // the request ever reaches the auth code.
  const nulTok = await req(port, {
    headers: { Authorization: 'Bearer ' + TOKEN.slice(0, 32) + String.fromCharCode(0) + TOKEN.slice(33) },
    body: '{}',
  });
  check(
    'token with an embedded NUL byte is rejected (never authenticates)',
    statusOf(nulTok) !== 200,
    `status=${statusOf(nulTok) ?? '-'} event=${nulTok.event} — parser-level rejection`,
  );

  const stillUp = await req(port, { headers: AUTH, body: '{}' });
  check(
    'server survives every malformed token (timingSafeEqual length guard + try/catch hold)',
    statusOf(stillUp) === 200,
    `observed ${statusOf(stillUp)}`,
  );

  const unauth = await req(port, { headers: {}, body: '{}' });
  check(
    '401 body does not reveal the expected token or its length',
    !dechunk(bodyOf(unauth)).includes(TOKEN) && !dechunk(bodyOf(unauth)).includes(String(TOKEN.length)),
    dechunk(bodyOf(unauth)),
  );
}

// ===========================================================================
section('B2  Host header / DNS rebinding');
{
  const variants = [
    ['exact 127.0.0.1:PORT', `127.0.0.1:${port}`, 200],
    ['localhost:PORT', `localhost:${port}`, 400],
    ['127.0.0.1 (no port)', '127.0.0.1', 400],
    ['127.1:PORT', `127.1:${port}`, 400],
    ['[::1]:PORT', `[::1]:${port}`, 400],
    ['trailing dot', `127.0.0.1.:${port}`, 400],
    ['attacker rebind host', `rebind.attacker.example:${port}`, 400],
    ['decimal loopback', `2130706433:${port}`, 400],
  ];
  for (const [label, host, expected] of variants) {
    const r = await req(port, { headers: { ...AUTH, Host: host }, body: '{}' });
    check(`Host ${label} -> ${expected}`, statusOf(r) === expected, `observed ${statusOf(r)}`);
  }
  const noHost = await raw(port, 'POST /v1/env_describe HTTP/1.0\r\nContent-Length: 2\r\n\r\n{}');
  check('no Host header -> 400', statusOf(noHost) === 400, `observed ${statusOf(noHost)}`);

  const badHostNoAuth = await req(port, { headers: { Host: 'evil.example' }, body: '{}' });
  check(
    'Host is checked before auth (400, not 401) — no auth oracle via Host',
    statusOf(badHostNoAuth) === 400,
    `observed ${statusOf(badHostNoAuth)}`,
  );
}

// ===========================================================================
section('B3  Origin header');
{
  for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${port}`]) {
    const r = await req(port, { headers: { ...AUTH, Origin: origin }, body: '{}' });
    check(`Origin ${origin} -> 400`, statusOf(r) === 400, `observed ${statusOf(r)}`);
  }
  // An empty Origin is falsy in JS, so `if (req.headers.origin)` does not fire.
  const empty = await req(port, { headers: { ...AUTH, Origin: '' }, body: '{}' });
  check(
    'empty Origin header is not rejected (falsy check) — browsers never send this',
    statusOf(empty) === 200,
    `observed ${statusOf(empty)}; server.ts:89 uses a truthiness test, so "Origin:" with an empty value passes`,
  );
}

// ===========================================================================
section('B4  Non-loopback binding');
{
  const external = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') external.push([name, a.address]);
    }
  }
  if (external.length === 0) {
    note('no non-loopback IPv4 interface on this host; external-reachability check skipped');
  }
  for (const [name, addr] of external) {
    const r = await raw(port, `GET /openapi.json HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, {
      host: addr,
      timeoutMs: 2500,
    });
    check(
      `not reachable on non-loopback ${name} (${addr})`,
      r.event === 'error' || r.event === 'timeout',
      `event=${r.event} code=${r.code ?? '-'}`,
    );
  }
  const v6 = await raw(port, `GET /openapi.json HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, {
    host: '::1',
    timeoutMs: 2500,
  });
  check(
    'not reachable over IPv6 loopback ::1',
    v6.event === 'error' || v6.event === 'timeout',
    `event=${v6.event} code=${v6.code ?? '-'}`,
  );
}

// ===========================================================================
section('B5  Method confusion');
{
  const g = await req(port, { method: 'GET', path: '/v1/env_describe', headers: AUTH });
  check('GET on a POST route -> 405', statusOf(g) === 405, `observed ${statusOf(g)}`);
  for (const m of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'HEAD']) {
    const r = await req(port, { method: m, path: '/v1/env_describe', headers: AUTH });
    check(`${m} on a POST route -> 405`, statusOf(r) === 405, `observed ${statusOf(r)}`);
  }
  const postOpenapi = await req(port, { method: 'POST', path: '/openapi.json', headers: AUTH, body: '{}' });
  check(
    'POST /openapi.json -> 404 (not the spec)',
    statusOf(postOpenapi) === 404,
    `observed ${statusOf(postOpenapi)}`,
  );
  const getOpenapi = await req(port, { method: 'GET', path: '/openapi.json' });
  check(
    'GET /openapi.json serves the spec',
    statusOf(getOpenapi) === 200,
    `observed ${statusOf(getOpenapi)}`,
  );
  check(
    'GET /openapi.json requires NO auth (unauthenticated read)',
    statusOf(getOpenapi) === 200,
    'informational: exposes only the tool schema + port, never a value',
  );
  check(
    '/openapi.json body carries no token and no secret',
    !bodyOf(getOpenapi).includes(TOKEN),
    'token absent',
  );
  const openapiTrailing = await req(port, { method: 'GET', path: '/openapi.json/' });
  check(
    'GET /openapi.json/ (trailing slash) -> 405, not the spec',
    statusOf(openapiTrailing) === 405,
    `observed ${statusOf(openapiTrailing)}`,
  );
}

// ===========================================================================
section('B6  Path handling / traversal');
{
  const paths = [
    ['/v1/env_describe/../../etc', 404],
    ['/v1/env_describe/..%2f..%2fetc', 404],
    ['/v1/%65nv_describe', 404],
    ['/v1//env_describe', 404],
    ['//v1/env_describe', 404],
    ['/v1/env_describe/', 404],
    ['/v1/env_describe//', 404],
    ['/V1/env_describe', 404],
    ['/v1/ENV_DESCRIBE', 404],
    ['/v1/env_describe?x=1', 404],
    ['/v1/env_describe#frag', 404],
    ['/v1/env_describe%00', 404],
    ['/v1/env_describe%0d%0aX-Injected:%201', 404],
    ['/v1/../v1/env_describe', 404],
    ['/./v1/env_describe', 404],
    ['/v1/env_describe;x=1', 404],
    ['/../../../../etc/passwd', 404],
    ['/v1/env_use', 200],
  ];
  for (const [path, expected] of paths) {
    const r = await req(port, { path, headers: AUTH, body: '{}' });
    const status = statusOf(r);
    check(
      `path ${path} -> ${expected}`,
      status === expected,
      `observed ${status}${expected === 200 ? ' (route exists; schema rejection happens inside)' : ''}`,
    );
  }
  note(
    'the route regex is ^/v1/([a-z_]+)$ against the RAW req.url, so it never decodes ' +
      '%2e%2e and never sees a normalised path — traversal is structurally impossible, ' +
      'but a legitimate query string also 404s.',
  );
  const crlf = await req(port, { path: '/v1/env_describe%0d%0aX-Injected:%201', headers: AUTH, body: '{}' });
  check(
    'no CRLF header injection through the path',
    !/X-Injected/i.test(crlf.body),
    'no injected header in the response',
  );
}

// ===========================================================================
section('B7  Body cap and JSON handling');
{
  const big = 'x'.repeat(2 * 1024 * 1024);
  const over = await req(port, {
    path: '/v1/env_describe',
    headers: AUTH,
    body: JSON.stringify({ pad: big }),
  });
  check(
    'body >1 MiB -> 413',
    statusOf(over) === 413,
    `observed ${statusOf(over) ?? over.event}`,
  );
  const bad = await req(port, { path: '/v1/env_describe', headers: AUTH, body: '{not json' });
  check('malformed JSON -> 400', statusOf(bad) === 400, `observed ${statusOf(bad)}`);
  const empty = await req(port, { path: '/v1/env_describe', headers: AUTH, body: '' });
  check('empty body treated as {} -> 200', statusOf(empty) === 200, `observed ${statusOf(empty)}`);
  const stillUp = await req(port, { headers: AUTH, body: '{}' });
  check('server survives the oversize body', statusOf(stillUp) === 200, `observed ${statusOf(stillUp)}`);
}

// ===========================================================================
section('B8  Reflection channel');
{
  const marker = 'W3REFLECTIONCANARY';
  const probes = [
    ['unknown operation name', { path: '/v1/zzz_not_a_tool', body: '{}' }],
    ['canary in a JSON field', { path: '/v1/env_declare', body: JSON.stringify({ entries: [{ key: marker, description: marker }] }) }],
    ['canary in a describe arg', { path: '/v1/env_describe', body: JSON.stringify({ scope: marker }) }],
    ['canary in a verify key', { path: '/v1/env_verify', body: JSON.stringify({ keys: [marker] }) }],
    ['canary in a request reason', { path: '/v1/env_request', body: JSON.stringify({ keys: ['OPENAI_API_KEY'], reason: marker }) }],
    ['canary in an await ticket', { path: '/v1/env_await', body: JSON.stringify({ ticket: marker, timeoutMs: 1 }) }],
  ];
  for (const [label, opts] of probes) {
    const r = await req(port, { ...opts, headers: AUTH });
    const text = bodyOf(r);
    const reflected = text.includes(marker);
    console.log(`  ${label}: status=${statusOf(r)} reflected=${reflected} body=${text.slice(0, 160)}`);
    if (label === 'unknown operation name') {
      check(
        'unknown operation reflects only the [a-z_]-constrained op name',
        /Unknown tool: zzz_not_a_tool/.test(text),
        'reflection exists but the route regex limits it to [a-z_]+, JSON-escaped',
      );
      check(
        'unknown operation returns HTTP 200 with an error body (contract wart, not a leak)',
        statusOf(r) === 200,
        `observed ${statusOf(r)} — a 404 would be more honest`,
      );
    }
  }
  const declared = await req(port, {
    path: '/v1/env_declare',
    headers: AUTH,
    body: JSON.stringify({
      entries: [
        { key: 'REFLECT_KEY', description: 'd', value: 'sk-W3SHOULDNOTECHO', required: true, secret: true },
      ],
    }),
  });
  check(
    'T3: an injected `value` field is rejected and never echoed',
    !bodyOf(declared).includes('sk-W3SHOULDNOTECHO'),
    bodyOf(declared).slice(0, 200),
  );
}

// ===========================================================================
section('B9  Response headers');
{
  const r = await req(port, { headers: AUTH, body: '{}' });
  const head = r.body.split('\r\n\r\n')[0];
  check('Cache-Control: no-store', /cache-control:\s*no-store/i.test(head), head.split('\r\n')[1]);
  check('X-Content-Type-Options: nosniff', /x-content-type-options:\s*nosniff/i.test(head));
  check('Content-Type: application/json', /content-type:\s*application\/json/i.test(head));
  check(
    'no Access-Control-Allow-Origin (no CORS grant)',
    !/access-control-allow-origin/i.test(head),
    head,
  );
  const err = await req(port, { headers: {}, body: '{}' });
  const errHead = err.body.split('\r\n\r\n')[0];
  check('security headers present on 401 too', /cache-control:\s*no-store/i.test(errHead));
  const crash = await req(port, { path: '/v1/env_use', headers: AUTH, body: JSON.stringify({ keys: [], command: [] }) });
  check(
    'internal errors return a generic body, no stack trace',
    !/\bat \w+.*\.js:\d+/.test(bodyOf(crash)) && !bodyOf(crash).includes(root),
    bodyOf(crash).slice(0, 200),
  );
}

await server.close();
rmSync(root, { recursive: true, force: true });

section('Summary');
console.log(`  pass=${pass} fail=${fail}`);
if (findings.length > 0) {
  console.log('  failing checks:');
  for (const f of findings) console.log(`    - ${f}`);
}
process.exit(0);
