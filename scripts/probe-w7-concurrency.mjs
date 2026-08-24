// W7 — concurrency and ticket lifetime.
//
// Two brokers on one project is the realistic case: an MCP server and a CLI
// invocation, or two agent sessions. Nothing coordinates them, so the only
// thing preventing a mangled `.env` is the atomic rename. This probe drives
// interleaved writes hard and then checks the file still parses and every
// value is intact. It also asks whether a ticket left to expire reports
// `expired` or just stops responding.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Broker, projectPaths, parseDotenv, readDotenv } from '../packages/core/dist/index.js';
import { TicketStore } from '../packages/core/dist/tickets.js';

const roots = [];
function newRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `envseal-w7-${name}-`));
  roots.push(root);
  writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
  return root;
}

console.log('=== W7 concurrency and ticket lifetime ===\n');

// --- 1. two processes writing the SAME key concurrently -----------------
{
  const root = newRoot('conc-same');
  const paths = projectPaths(root);
  const WRITES = 400;
  const src = `
import { projectPaths, setDotenvValue } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'packages', 'core', 'dist', 'index.js')).href)};
const p = projectPaths(process.argv[2]);
const tag = process.argv[3];
for (let i = 0; i < ${WRITES}; i++) setDotenvValue(p, 'SHARED_KEY', tag + '-' + String(i).padStart(4, '0'));
`;
  const f = join(root, 'w.mjs');
  writeFileSync(f, src, 'utf8');

  const kids = ['alpha', 'bravo'].map((tag) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [f, root, tag], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', (d) => (err += d));
      c.on('exit', (code) => resolve({ tag, code, err: err.trim().split('\n')[0] }));
    }),
  );
  const results = await Promise.all(kids);

  const text = readFileSync(paths.dotenv, 'utf8');
  const parsed = parseDotenv(text);
  const assignments = parsed.lines.filter((l) => l.kind === 'assignment' && l.key === 'SHARED_KEY');
  const values = readDotenv(paths);
  const winner = values.SHARED_KEY ?? '<none>';
  const wellFormed = /^(alpha|bravo)-\d{4}$/.test(winner);
  const raws = parsed.lines.filter((l) => l.kind === 'raw');

  console.log(`1. two processes, ${WRITES} writes each, SAME key`);
  console.log('   expected : file parses; exactly one SHARED_KEY line; its value is a complete tag-NNNN');
  console.log(`   child exits: ${JSON.stringify(results)}`);
  console.log(`   SHARED_KEY line count : ${assignments.length}`);
  console.log(`   final value           : ${JSON.stringify(winner)} wellFormed=${wellFormed}`);
  console.log(`   unparseable "raw" lines: ${raws.length} ${raws.length ? JSON.stringify(raws.slice(0, 3).map((l) => l.text.slice(0, 60))) : ''}`);
  console.log(`   leftover .tmp files   : ${JSON.stringify(readdirSync(root).filter((x) => x.endsWith('.tmp')))}`);
  if (assignments.length !== 1 || !wellFormed || raws.length > 0) {
    console.log('   !! INTERLEAVED CORRUPTION  <-- HIGH');
  } else {
    console.log('   no interleaved corruption of the target file');
  }
  console.log();
}

// --- 2. two processes writing DIFFERENT keys: lost-update check ---------
// Read-modify-write is not serialised, so a concurrent writer's key can be
// silently dropped even though the file itself stays well-formed. That is a
// different failure from corruption and it is the one that actually bites.
{
  const root = newRoot('conc-diff');
  const paths = projectPaths(root);
  const WRITES = 300;
  const src = `
import { projectPaths, setDotenvValue } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'packages', 'core', 'dist', 'index.js')).href)};
const p = projectPaths(process.argv[2]);
const tag = process.argv[3];
for (let i = 0; i < ${WRITES}; i++) setDotenvValue(p, 'KEY_' + tag, tag + '-' + String(i).padStart(4, '0'));
`;
  const f = join(root, 'w.mjs');
  writeFileSync(f, src, 'utf8');
  await Promise.all(
    ['ALPHA', 'BRAVO'].map((tag) =>
      new Promise((resolve) => spawn(process.execPath, [f, root, tag], { stdio: 'ignore' }).on('exit', resolve)),
    ),
  );

  const values = readDotenv(paths);
  const parsed = parseDotenv(readFileSync(paths.dotenv, 'utf8'));
  console.log(`2. two processes, ${WRITES} writes each, DIFFERENT keys`);
  console.log('   expected : both KEY_ALPHA and KEY_BRAVO present at the end');
  console.log(`   KEY_ALPHA : ${JSON.stringify(values.KEY_ALPHA ?? null)}`);
  console.log(`   KEY_BRAVO : ${JSON.stringify(values.KEY_BRAVO ?? null)}`);
  console.log(`   unparseable "raw" lines: ${parsed.lines.filter((l) => l.kind === 'raw').length}`);
  if (values.KEY_ALPHA === undefined || values.KEY_BRAVO === undefined) {
    console.log('   !! LOST UPDATE: a concurrent writer silently dropped the other key  <-- HIGH');
  } else {
    console.log('   both keys survived');
  }
  console.log();
}

// --- 3. two Broker instances on one project, same key -------------------
{
  const root = newRoot('conc-broker');
  const paths = projectPaths(root);
  const makePrompter = (value) => ({
    id: 'ide',
    available: async () => true,
    prompt: async (req) => ({
      ticket: req.ticket,
      results: req.keys.map((k) => ({ key: k.key, outcome: 'entered', value: Buffer.from(value, 'utf8') })),
    }),
    cancel: async () => {},
  });

  const a = new Broker({ root, prompter: makePrompter('value-from-broker-A') });
  const b = new Broker({ root, prompter: makePrompter('value-from-broker-B') });
  await a.declare({ entries: [{ key: 'SHARED_KEY', description: 'w7 concurrent', required: true, secret: true }] });

  const [ta, tb] = await Promise.all([
    a.request({ keys: ['SHARED_KEY'], reason: 'broker A' }),
    b.request({ keys: ['SHARED_KEY'], reason: 'broker B' }),
  ]);
  const [oa, ob] = await Promise.all([
    a.await({ ticket: ta.ticket, timeoutMs: 10_000 }),
    b.await({ ticket: tb.ticket, timeoutMs: 10_000 }),
  ]);

  const text = readFileSync(paths.dotenv, 'utf8');
  const parsed = parseDotenv(text);
  const lines = parsed.lines.filter((l) => l.kind === 'assignment' && l.key === 'SHARED_KEY');
  const value = readDotenv(paths).SHARED_KEY;
  console.log('3. two Broker instances, both requesting the same key');
  console.log('   expected : both tickets resolve; file holds exactly one complete value');
  console.log(`   A outcome: ${JSON.stringify(oa)}`);
  console.log(`   B outcome: ${JSON.stringify(ob)}`);
  console.log(`   SHARED_KEY line count: ${lines.length}; value=${JSON.stringify(value)}`);
  const ok = lines.length === 1 && (value === 'value-from-broker-A' || value === 'value-from-broker-B');
  console.log(`   ${ok ? 'no interleaved corruption' : '!! INTERLEAVED CORRUPTION  <-- HIGH'}`);
  a.dispose();
  b.dispose();
  console.log();
}

// --- 4. ticket TTL expiry -----------------------------------------------
// Records only flip to `expired` when the 60s sweep runs. Awaiting a ticket
// that is past its TTL but has not yet been swept should still report
// `expired` — reporting `pending` after the wait tells the caller nothing
// happened when in fact the ticket is dead.
{
  // 4z first: both the sweep interval and the per-await timeout are unref'd
  // (tickets.ts), so with nothing else holding the event loop open the awaited
  // promise is simply dropped and Node exits 13. Prove that in a child, then
  // hold a ref'd handle for the remaining cases so they can be measured.
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { TicketStore } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'packages', 'core', 'dist', 'tickets.js')).href)};
       const s = new TicketStore({ ttlMs: 300, sweepIntervalMs: 60000 });
       const r = s.create({ keys: ['K'], reason: 'x', surface: 'none' });
       const o = await s.await(r.ticket, 2000);
       console.log('SETTLED ' + JSON.stringify(o));
       s.dispose();`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const childResult = await new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
  });
  console.log('4z. await() with nothing else holding the event loop open');
  console.log('   expected : settles within timeoutMs and the caller sees an outcome');
  console.log(`   observed : exit=${childResult.code} stdout=${JSON.stringify(childResult.out)}`);
  console.log(`              stderr first line: ${JSON.stringify(childResult.err.split('\n')[0])}`);
  if (childResult.out === '') {
    console.log('   !! the await NEVER SETTLED — the process exited without an outcome  <-- HIGH');
  }
  console.log();

  const keepalive = setInterval(() => {}, 1000);

  const store = new TicketStore({ ttlMs: 300, sweepIntervalMs: 60_000 });
  const rec = store.create({ keys: ['K'], reason: 'ttl probe', surface: 'none' });
  await new Promise((r) => setTimeout(r, 900));
  const started = Date.now();
  const outcome = await store.await(rec.ticket, 2000);
  const elapsed = Date.now() - started;
  console.log('4a. await() on a ticket already past its TTL (sweep interval 60s, not yet run)');
  console.log('   expected : returns promptly with state="expired"');
  console.log(`   observed : state=${JSON.stringify(outcome.state)} after ${elapsed}ms`);
  if (outcome.state !== 'expired') {
    console.log(`   !! TTL not honoured on await: reported "${outcome.state}" and only after the await timeout  <-- MEDIUM`);
  }
  store.dispose();

  const store2 = new TicketStore({ ttlMs: 300, sweepIntervalMs: 100 });
  const rec2 = store2.create({ keys: ['K'], reason: 'ttl probe', surface: 'none' });
  const started2 = Date.now();
  const outcome2 = await store2.await(rec2.ticket, 5000);
  console.log('4b. await() with the sweep running (100ms interval)');
  console.log('   expected : resolves as "expired" shortly after the 300ms TTL, not at the 5000ms await timeout');
  console.log(`   observed : state=${JSON.stringify(outcome2.state)} after ${Date.now() - started2}ms`);
  store2.dispose();

  const store3 = new TicketStore({ ttlMs: 300, sweepIntervalMs: 100 });
  const started3 = Date.now();
  const outcome3 = await store3.await('01UNKNOWNTICKETUNKNOWNTICK', 5000);
  console.log('4c. await() on an unknown ticket id');
  console.log('   expected : immediate, non-hanging answer');
  console.log(`   observed : state=${JSON.stringify(outcome3.state)} after ${Date.now() - started3}ms`);
  store3.dispose();
  clearInterval(keepalive);
  console.log();
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
