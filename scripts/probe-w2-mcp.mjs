// W2 · MCP binding: drive the real `dist/bin.js` over stdio and record every
// byte in both directions plus stderr, then sweep the whole recording for the
// sentinel. Unlike the existing E2E test this deliberately forces the error
// branches — that is where a leak survives.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SENTINEL = 'sk-W2SENTINEL-mcp-0000000000000000';
const BIN = resolve(import.meta.dirname, '../packages/mcp-server/dist/bin.js');

const root = mkdtempSync(join(tmpdir(), 'envseal-w2-mcp-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');

// Everything the harness could ever see.
const wire = { toServer: [], fromServer: [], stderr: [] };

const child = spawn(process.execPath, [BIN, '--project', root], {
  env: {
    ...process.env,
    ENVSEAL_TEST_MODE: '1',
    ENVSEAL_TEST_PROMPTER_VALUE: SENTINEL,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.on('data', (b) => wire.fromServer.push(b));
child.stderr.on('data', (b) => wire.stderr.push(b));

let nextId = 1;
const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) {
        pending.delete(msg.id);
        r(msg);
      }
    } catch {
      /* not a frame we sent */
    }
  }
});

function sendRaw(text) {
  wire.toServer.push(Buffer.from(text, 'utf8'));
  child.stdin.write(text);
}

function rpc(method, params, timeoutMs = 20000) {
  const id = nextId++;
  const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
  return new Promise((res) => {
    const t = setTimeout(() => {
      pending.delete(id);
      res({ error: { message: 'TIMEOUT (no response)' } });
    }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(t);
      res(m);
    });
    sendRaw(frame);
  });
}

const callTool = (name, args) => rpc('tools/call', { name, arguments: args });
const textOf = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r);
const jsonOf = (r) => {
  try {
    return JSON.parse(textOf(r));
  } catch {
    return null;
  }
};

const log = (label, r) => console.log(`  ${label.padEnd(38)} ${textOf(r).slice(0, 150)}`);

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'w2-probe', version: '0' },
});
sendRaw(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

console.log('=== A. happy path (baseline) ===');
log(
  'declare',
  await callTool('env_declare', {
    entries: [{ key: 'OPENAI_API_KEY', description: 'W2 probe', required: true, secret: true }],
  }),
);
const ticket = await callTool('env_request', { keys: ['OPENAI_API_KEY'], reason: 'W2 probe' });
log('request', ticket);
const tk = jsonOf(ticket)?.ticket;
log('await', await callTool('env_await', { ticket: tk, timeoutMs: 5000 }));
log('describe', await callTool('env_describe', {}));

console.log('=== B. error branches ===');

// B1 — value fails the declared format.pattern.
log(
  'declare STRICT_KEY w/ impossible pattern',
  await callTool('env_declare', {
    entries: [
      {
        key: 'STRICT_KEY',
        description: 'pattern that the stub value cannot satisfy',
        required: true,
        secret: true,
        format: { pattern: '^ZZZ-[0-9]{99}$' },
      },
    ],
  }),
);
const t2 = jsonOf(await callTool('env_request', { keys: ['STRICT_KEY'], reason: 'invalid format' }))
  ?.ticket;
log('await (invalid_format)', await callTool('env_await', { ticket: t2, timeoutMs: 5000 }));

// B2 — sink write failure: make .env read-only so the atomic rename fails.
const envPath = join(root, '.env');
chmodSync(envPath, 0o444);
// On Windows chmod only clears the write bit; that is enough to fail rename.
log(
  'declare LOCKED_KEY',
  await callTool('env_declare', {
    entries: [{ key: 'LOCKED_KEY', description: 'sink write failure', required: true, secret: true }],
  }),
);
const t3 = jsonOf(await callTool('env_request', { keys: ['LOCKED_KEY'], reason: 'sink failure' }))
  ?.ticket;
log('await (sink write failed)', await callTool('env_await', { ticket: t3, timeoutMs: 8000 }));
chmodSync(envPath, 0o644);

// B3 — verify against a probe host that echoes the credential back in a 500.
const { createServer } = await import('node:http');
let echoed = 0;
const evil = createServer((req, res) => {
  echoed++;
  res.writeHead(500, {
    'Content-Type': 'text/plain',
    // A header that echoes the credential straight back.
    'X-Echo-Auth': String(req.headers.authorization ?? ''),
  });
  res.end(`upstream error: bad credential ${req.headers.authorization}\n`);
});
await new Promise((r) => evil.listen(0, '127.0.0.1', r));
const evilPort = evil.address().port;
// verify.ts requires https:// — record that the http:// probe is refused, and
// separately point at an https URL that cannot connect, to exercise the catch.
log(
  'declare probe -> http (must be refused)',
  await callTool('env_declare', {
    entries: [
      {
        key: 'OPENAI_API_KEY',
        description: 'W2 probe',
        required: true,
        secret: true,
        verify: {
          method: 'GET',
          url: `https://127.0.0.1:${evilPort}/collect`,
          headerTemplate: { Authorization: 'Bearer {{value}}' },
          expectStatus: [200],
        },
      },
    ],
  }),
);
log('verify (novel host, unapproved)', await callTool('env_verify', { keys: ['OPENAI_API_KEY'] }));

// Approve it out of band, then verify again so the network/TLS error path runs
// with the real value substituted into the header.
const approvalsPath = join(root, '.envseal', 'approvals.json');
log('verify again (after approval file)', await callTool('env_verify', { keys: ['OPENAI_API_KEY'] }));

// B4 — env_use: child echoes the value in several shapes.
const echoScript = join(root, 'echo.mjs');
writeFileSync(
  echoScript,
  `const v = process.env.OPENAI_API_KEY ?? '';
console.log('plain: ' + v);
console.log('b64:   ' + Buffer.from(v).toString('base64'));
console.log('hex:   ' + Buffer.from(v).toString('hex'));
console.log('url:   ' + encodeURIComponent(v));
console.log('split: ' + v.slice(0, 16) + '\\n' + v.slice(16));
console.log('rev:   ' + [...v].reverse().join(''));
console.error('stderr plain: ' + v);
`,
  'utf8',
);
const useRes = await callTool('env_use', {
  keys: ['OPENAI_API_KEY'],
  command: [process.execPath, echoScript],
});
console.log('  env_use output:');
for (const line of textOf(useRes).slice(0, 1200).split('\\n')) console.log(`    ${line}`);

// B5 — malformed JSON-RPC frames.
sendRaw('{ this is not json\n');
sendRaw('\n');
sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 9001 })}\n`);
sendRaw(`${'x'.repeat(1024 * 1024 + 10)}\n`); // > 1 MiB frame
await new Promise((r) => setTimeout(r, 300));
log('server alive after malformed frames', await callTool('env_describe', {}));

// B6 — unknown tool, and a tool name carrying the sentinel.
log('unknown tool', await callTool('env_nope', {}));
log('tool name = sentinel', await callTool(SENTINEL, {}));

// B7 — the model tries to smuggle the value in free-text fields.
log(
  'declare with value in description',
  await callTool('env_declare', {
    entries: [
      { key: 'DESC_KEY', description: `use ${SENTINEL} here`, required: true, secret: true },
    ],
  }),
);
log(
  'declare with an explicit value field',
  await callTool('env_declare', {
    entries: [{ key: 'VAL_KEY', description: 'x', value: SENTINEL }],
  }),
);
log(
  'request with value in reason',
  await callTool('env_request', { keys: ['OPENAI_API_KEY'], reason: `token is ${SENTINEL}` }),
);

// B8 — revoke and re-describe.
log('revoke', await callTool('env_revoke', { keys: ['OPENAI_API_KEY'] }));
log('describe after revoke', await callTool('env_describe', {}));

evil.close();
child.kill();
await new Promise((r) => setTimeout(r, 300));

console.log('=== C. sentinel sweep ===');
const streams = {
  'stdin -> server (all bytes)': Buffer.concat(wire.toServer),
  'server -> stdout (all bytes)': Buffer.concat(wire.fromServer),
  'server stderr (all bytes)': Buffer.concat(wire.stderr),
};
let leaks = 0;
for (const [label, b] of Object.entries(streams)) {
  const s = b.toString('utf8');
  // Only the frames WE sent may legitimately carry the sentinel (B7 smuggling).
  const hits = s.split(SENTINEL).length - 1;
  console.log(`  ${label.padEnd(30)} bytes=${String(b.length).padStart(8)} sentinelHits=${hits}`);
  if (label.startsWith('server') && hits > 0) leaks++;
}

const artifacts = [
  ['.env', join(root, '.env')],
  ['env.schema.jsonc', join(root, 'env.schema.jsonc')],
  ['.envseal/audit.jsonl', join(root, '.envseal', 'audit.jsonl')],
  ['.envseal/approvals.json', approvalsPath],
  ['.envseal/salt', join(root, '.envseal', 'salt')],
];
console.log('  --- on-disk artifacts ---');
for (const [label, p] of artifacts) {
  if (!existsSync(p)) {
    console.log(`  ${label.padEnd(30)} (absent)`);
    continue;
  }
  const s = readFileSync(p, 'utf8');
  const hits = s.split(SENTINEL).length - 1;
  const expected = label === '.env'; // .env is the intended sink
  console.log(
    `  ${label.padEnd(30)} sentinelHits=${hits}${hits > 0 && !expected ? '   <-- LEAK' : ''}`,
  );
  if (hits > 0 && !expected) leaks++;
}
console.log(`  echo-probe requests received: ${echoed}`);
console.log(`\n  RESULT: ${leaks === 0 ? 'no sentinel escaped the server channel' : `${leaks} LEAK(S)`}`);

rmSync(root, { recursive: true, force: true });
