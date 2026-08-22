// W2 · SDK binding + redactor edge cases.
//
// Accumulates EVERY value returned by `dispatch` and sweeps it for the
// sentinel, then hammers the redactor's stated boundaries (§7.4): the 8-byte
// floor, the 20-char prefix rule, encoding variants, multi-byte values, a
// value containing the replacement token, and two values where one contains
// the other.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker, dispatch } from '../packages/sdk/dist/index.js';
import { Broker, redact } from '../packages/core/dist/index.js';
import { secretFromUtf8 } from '../packages/protocol/dist/index.js';
import { verifyKey } from '../packages/core/dist/verify.js';
import { projectPaths } from '../packages/core/dist/paths.js';

const SENTINEL = 'sk-W2SENTINEL-sdk-11112222333344445555';

function freshRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `envseal-w2-${tag}-`));
  writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
  return root;
}

const stubPrompter = (value) => ({
  id: 'ide',
  available: async () => true,
  prompt: async (req) => ({
    ticket: req.ticket,
    results: req.keys.map((k) => ({ key: k.key, outcome: 'entered', value: secretFromUtf8(value) })),
  }),
  cancel: async () => {},
});

// ---------------------------------------------------------------- 1. dispatch sweep
console.log('=== 1. SDK dispatch: accumulate every returned value ===');
{
  const root = freshRoot('sdk');
  const broker = createBroker({ root, prompter: stubPrompter(SENTINEL) });
  const seen = [];
  const call = async (n, a) => {
    const r = await dispatch(broker, n, a);
    seen.push(JSON.stringify(r));
    return r;
  };

  await call('env_declare', {
    entries: [{ key: 'OPENAI_API_KEY', description: 'w2', required: true, secret: true }],
  });
  const t = await call('env_request', { keys: ['OPENAI_API_KEY'], reason: 'w2 sdk' });
  await call('env_await', { ticket: t.ticket, timeoutMs: 5000 });
  await call('env_describe', {});
  await call('env_verify', { keys: ['OPENAI_API_KEY'] });
  // env_use through the SDK: createBroker wires no onConfirm.
  await call('env_use', { keys: ['OPENAI_API_KEY'], command: [process.execPath, '-e', 'console.log(process.env.OPENAI_API_KEY)'] });
  await call('env_revoke', { keys: ['OPENAI_API_KEY'] });
  // Malformed / hostile inputs.
  await call('env_describe', { scope: SENTINEL });
  await call('env_declare', { entries: [{ key: 'BAD KEY NAME', description: SENTINEL }] });
  await call('env_await', { ticket: 'not-a-ticket', timeoutMs: 1000 });
  await call('env_nope', { x: SENTINEL });

  const blob = seen.join('\n');
  console.log(`  dispatch results: ${seen.length}, bytes=${blob.length}`);
  console.log(`  sentinel in returned values: ${blob.includes(SENTINEL)}`);
  console.log(`  env_use result: ${seen.find((s) => s.includes('CONFIRMATION')) ? 'SEP_CONFIRMATION_DENIED (no onConfirm wired in createBroker)' : 'ran'}`);
  const dotenv = existsSync(join(root, '.env')) ? readFileSync(join(root, '.env'), 'utf8') : '';
  console.log(`  .env holds the value: ${dotenv.includes(SENTINEL)} (expected true before revoke, false after)`);
  broker.dispose();
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 2. env_use redaction
console.log('\n=== 2. env_use output redaction (onConfirm supplied) ===');
{
  const root = freshRoot('use');
  const broker = new Broker({ root, prompter: stubPrompter(SENTINEL), onConfirm: async () => true });
  await broker.declare({
    entries: [{ key: 'OPENAI_API_KEY', description: 'w2', required: true, secret: true }],
  });
  const t = await broker.request({ keys: ['OPENAI_API_KEY'], reason: 'w2' });
  await broker.await({ ticket: t.ticket, timeoutMs: 5000 });

  const script = join(root, 'echo.mjs');
  writeFileSync(
    script,
    `const v = process.env.OPENAI_API_KEY ?? '';
const out = {
  plain: v,
  base64: Buffer.from(v).toString('base64'),
  base64url: Buffer.from(v).toString('base64url'),
  hex: Buffer.from(v).toString('hex'),
  urlenc: encodeURIComponent(v),
  jsonesc: JSON.stringify(v).slice(1, -1),
  reversed: [...v].reverse().join(''),
  prefix19: v.slice(0, 19),
  prefix20: v.slice(0, 20),
  withNewline: v.slice(0, 10) + '\\n' + v.slice(10),
  charCodes: [...v].map((c) => c.charCodeAt(0)).join(','),
};
for (const [k, val] of Object.entries(out)) console.log(k + '=' + val);
console.error('stderr=' + v);
`,
    'utf8',
  );
  const res = await broker.use({ keys: ['OPENAI_API_KEY'], command: [process.execPath, script] });
  const combined = res.stdout + res.stderr;
  console.log(`  redactedCount=${res.redactedCount}  exitCode=${res.exitCode}`);
  for (const line of res.stdout.split(/\r?\n/).filter(Boolean)) {
    const [k] = line.split('=');
    const leaked = line.includes(SENTINEL);
    console.log(`    ${k.padEnd(12)} ${leaked ? 'RAW SENTINEL PRESENT' : 'redacted/absent'}  ${line.slice(0, 90)}`);
  }
  console.log(`  stderr redacted: ${!res.stderr.includes(SENTINEL)}`);
  console.log(`  token used: ${/«redacted:[A-Z_]+»/.test(combined) ? 'labelled «redacted:KEY»' : /«redacted»/.test(combined) ? 'UNLABELLED «redacted» (PLAN §7.4 promises «redacted:OPENAI_API_KEY»)' : 'none'}`);
  broker.dispose();
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. redactor boundaries
console.log('\n=== 3. redactor boundary cases ===');
const cases = [
  ['7-byte value (below MIN_SECRET_LENGTH)', 'abcdefg'],
  ['8-byte value (at the floor)', 'abcdefgh'],
  ['emoji / multi-byte', 'sk-🔑🔒🗝️-W2SENTINEL-emoji-000'],
  ['value containing the token literally', 'sk-«redacted»-W2SENTINEL-0000000'],
  ['value that is only digits', '12345678901234567890123456789012'],
  ['value with regex metachars', 'sk-.*+?^${}()|[]\\-W2SENTINEL-000'],
];
for (const [label, value] of cases) {
  const text = `before ${value} after`;
  const r = redact(text, [secretFromUtf8(value)]);
  const leaked = r.text.includes(value);
  console.log(`  ${label.padEnd(40)} count=${r.count} leaked=${leaked}${leaked ? '  <-- NOT REDACTED' : ''}`);
}

console.log('  --- one value contained in another ---');
{
  const inner = 'W2SENTINEL-inner-00000000000000000';
  const outer = `sk-${inner}-tail`;
  const r = redact(`A=${outer} B=${inner}`, [secretFromUtf8(inner), secretFromUtf8(outer)]);
  console.log(`    inner leaked=${r.text.includes(inner)}  outer leaked=${r.text.includes(outer)}`);
  console.log(`    -> ${r.text}`);
}
console.log('  --- 19- vs 20-char prefix ---');
{
  const v = 'sk-W2SENTINEL-prefixtest-000000000000';
  const r = redact(`p19=${v.slice(0, 19)} p20=${v.slice(0, 20)}`, [secretFromUtf8(v)]);
  console.log(`    ${r.text}`);
}

// ---------------------------------------------------------------- 4. verify egress
console.log('\n=== 4. env_verify against a hostile probe (fetch stubbed) ===');
{
  const root = freshRoot('verify');
  const paths = projectPaths(root);
  const entry = {
    key: 'OPENAI_API_KEY',
    description: 'w2',
    required: true,
    secret: true,
    sink: 'dotenv',
    verify: {
      method: 'GET',
      url: 'https://api.openai.com/v1/models', // registry-allowlisted host
      headerTemplate: { Authorization: 'Bearer {{value}}' },
      expectStatus: [200],
    },
  };
  const value = secretFromUtf8(SENTINEL);
  const realFetch = globalThis.fetch;
  const scenarios = [
    [
      '500 whose body echoes the credential',
      async (url, init) =>
        new Response(`error: invalid credential ${init.headers.Authorization}`, {
          status: 500,
          headers: { 'X-Echo': init.headers.Authorization },
        }),
    ],
    [
      '401 whose body echoes the credential',
      async (url, init) => new Response(`unauthorized: ${init.headers.Authorization}`, { status: 401 }),
    ],
    [
      '302 redirect to another host',
      async () => new Response('', { status: 302, headers: { Location: 'https://attacker.example/collect' } }),
    ],
    [
      'network error whose message embeds the credential',
      async (url, init) => {
        throw new Error(`connect ECONNREFUSED while sending ${init.headers.Authorization}`);
      },
    ],
  ];
  for (const [label, impl] of scenarios) {
    globalThis.fetch = impl;
    const r = await verifyKey(paths, entry, value);
    const leaked = JSON.stringify(r).includes(SENTINEL);
    console.log(`  ${label.padEnd(46)} result=${r.result.padEnd(14)} leaked=${leaked}${leaked ? '  <-- LEAK' : ''}`);
    console.log(`      message: ${JSON.stringify(r.message)}`);
  }
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5. hostile prompters
console.log('\n=== 5. prompters that misbehave ===');
for (const [label, prompter] of [
  [
    'prompter throws with the value in the message',
    {
      id: 'ide',
      available: async () => true,
      prompt: async () => {
        throw new Error(`prompt failed for value ${SENTINEL}`);
      },
      cancel: async () => {},
    },
  ],
  [
    'prompter returns a malformed shape',
    {
      id: 'ide',
      available: async () => true,
      prompt: async () => ({ nonsense: SENTINEL }),
      cancel: async () => {},
    },
  ],
  [
    'prompter returns outcome=entered with no value',
    {
      id: 'ide',
      available: async () => true,
      prompt: async (req) => ({
        ticket: req.ticket,
        results: req.keys.map((k) => ({ key: k.key, outcome: 'entered' })),
      }),
      cancel: async () => {},
    },
  ],
]) {
  const root = freshRoot('prompt');
  const broker = new Broker({ root, prompter });
  const out = [];
  try {
    await broker.declare({
      entries: [{ key: 'OPENAI_API_KEY', description: 'w2', required: true, secret: true }],
    });
    const t = await broker.request({ keys: ['OPENAI_API_KEY'], reason: 'w2' });
    out.push(JSON.stringify(await broker.await({ ticket: t.ticket, timeoutMs: 4000 })));
  } catch (e) {
    out.push(`THREW ${e.constructor.name}: ${e.message}`);
  }
  const audit = existsSync(join(root, '.envseal', 'audit.jsonl'))
    ? readFileSync(join(root, '.envseal', 'audit.jsonl'), 'utf8')
    : '';
  const blob = out.join('\n') + audit;
  console.log(`  ${label.padEnd(46)} leaked=${blob.includes(SENTINEL)}  -> ${out[0]?.slice(0, 90)}`);
  broker.dispose();
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 6. free-text smuggling
console.log('\n=== 6. free-text fields (T3): does anything reject a value? ===');
{
  const root = freshRoot('text');
  const broker = new Broker({ root, prompter: stubPrompter('x'.repeat(40)) });
  const results = {};
  // Seed a clean entry so the manifest exists for the leak scan below: since
  // the B2 fix every leaky declare in this section is REJECTED and writes
  // nothing, so without a seed readFileSync would find no file at all.
  await broker.declare({ entries: [{ key: 'SEED_KEY', description: 'clean seed', required: true }] });
  try {
    await broker.declare({
      entries: [{ key: 'DESC_KEY', description: `the key is ${SENTINEL}`, required: true, secret: true }],
    });
    results.description = 'ACCEPTED';
  } catch (e) {
    results.description = `rejected: ${e.code ?? e.message}`;
  }
  try {
    await broker.declare({
      entries: [
        {
          key: 'EX_KEY',
          description: 'x',
          required: true,
          secret: true,
          format: { pattern: '^.*$', example: SENTINEL },
        },
      ],
    });
    results['format.example'] = 'ACCEPTED';
  } catch (e) {
    results['format.example'] = `rejected: ${e.code ?? e.message}`;
  }
  try {
    await broker.request({ keys: ['DESC_KEY'], reason: `token ${SENTINEL}` });
    results.reason = 'ACCEPTED';
  } catch (e) {
    results.reason = `rejected: ${e.code ?? e.message}`;
  }
  try {
    await broker.declare({ entries: [{ key: 'V_KEY', description: 'x', value: SENTINEL }] });
    results['entry.value'] = 'ACCEPTED';
  } catch (e) {
    results['entry.value'] = `rejected: ${e.code ?? e.message}`;
  }
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(18)} ${v}`);

  const manifest = readFileSync(join(root, 'env.schema.jsonc'), 'utf8');
  const audit = readFileSync(join(root, '.envseal', 'audit.jsonl'), 'utf8');
  console.log(`  env.schema.jsonc contains sentinel: ${manifest.includes(SENTINEL)}  (this file is COMMITTED to git per PLAN §6.1)`);
  console.log(`  .envseal/audit.jsonl contains sentinel: ${audit.includes(SENTINEL)}  (PLAN §4.1: "names only, no values")`);
  broker.dispose();
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 7. redactor DoS
console.log('\n=== 7. redactor with an oversized value (regex compiler) ===');
for (const n of [3500, 4000]) {
  const v = 'sk-' + 'A'.repeat(n - 3);
  const { status, signal, stderr } = (await import('node:child_process')).spawnSync(
    process.execPath,
    ['-e', `import('${join(import.meta.dirname, '../packages/core/dist/index.js').replace(/\\/g, '/')}').then(async (m)=>{const p=await import('${join(import.meta.dirname, '../packages/protocol/dist/index.js').replace(/\\/g, '/')}');m.redact('x '+process.argv[1]+' y',[p.secretFromUtf8(process.argv[1])]);console.log('OK')})`, v],
    { encoding: 'utf8' },
  );
  const first = (stderr || '').split('\n').find((l) => /FATAL|Error/.test(l)) ?? '';
  console.log(`  value length ${String(n).padStart(5)}: exit=${status} signal=${signal ?? '-'} ${first.trim().slice(0, 80)}`);
}
