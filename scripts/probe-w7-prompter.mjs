// W7 — prompter selection matrix + the CI no-surface path.
//
// Two things are being checked. First, that selectPrompter() picks the surface
// PLAN.md §5.3 mandates for each env combination. Second — the one that
// actually matters — that a request made with no interactive surface fails
// fast with SEP_NO_INTERACTIVE_SURFACE and never blocks. Every case runs in a
// child process under a hard watchdog, so a hang shows up as a recorded
// TIMEOUT rather than wedging the probe.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(HERE, '..', 'packages');
const HARD_TIMEOUT_MS = 20_000;

function runChild(source, env) {
  const dir = mkdtempSync(join(tmpdir(), 'envseal-w7-p-'));
  const file = join(dir, 'case.mjs');
  writeFileSync(file, source, 'utf8');
  const started = Date.now();
  const res = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    timeout: HARD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  rmSync(dir, { recursive: true, force: true });
  return {
    ms: Date.now() - started,
    timedOut: res.signal === 'SIGKILL' || res.error?.code === 'ETIMEDOUT',
    code: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

// --- 1. selectPrompter() across env combinations -------------------------

const SELECT_SRC = `
import { selectPrompter } from ${JSON.stringify(pathToFileURL(join(DIST, 'prompters', 'dist', 'index.js')).href)};
const p = await selectPrompter(process.env.W7_ALLOW_TTY === '1' ? { allowTty: true } : {});
console.log(p.id);
`;

const selectCases = [
  ['CI=1', { CI: '1' }],
  ['CI=true', { CI: 'true' }],
  ['CI=0 (set but falsy)', { CI: '0' }],
  ['CI="" (empty string)', { CI: '' }],
  ['no CI, default', { CI: undefined }],
  ['no CI, SEP_PREFER_NATIVE=1', { CI: undefined, SEP_PREFER_NATIVE: '1' }],
  ['CI=1 + SEP_PREFER_NATIVE=1', { CI: '1', SEP_PREFER_NATIVE: '1' }],
  ['no CI, allowTty (no TTY on stdin)', { CI: undefined, W7_ALLOW_TTY: '1' }],
];

console.log('=== 1. selectPrompter() matrix ===');
for (const [label, env] of selectCases) {
  const scrub = { ...env };
  // spawnSync merges over process.env; an explicit undefined does not delete,
  // so blank it and let the code's `!== undefined` check see the empty string.
  // CI must actually be absent for the "no CI" rows, so delete it up front.
  const childEnv = { ...process.env };
  delete childEnv.CI;
  delete childEnv.SEP_PREFER_NATIVE;
  for (const [k, v] of Object.entries(scrub)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'envseal-w7-p-'));
  const file = join(dir, 'case.mjs');
  writeFileSync(file, SELECT_SRC, 'utf8');
  const res = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    timeout: HARD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  rmSync(dir, { recursive: true, force: true });
  const timedOut = res.signal === 'SIGKILL';
  console.log(
    `  ${label.padEnd(34)} -> ${timedOut ? 'TIMEOUT (HANG)' : (res.stdout ?? '').trim() || `exit ${res.status} ${(res.stderr ?? '').trim().split('\n')[0]}`}` +
      `  [${Date.now() - started}ms]`,
  );
}

// --- 2. env_request with CI=1: must not hang, must report no surface -----

const REQUEST_SRC = `
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from ${JSON.stringify(pathToFileURL(join(DIST, 'core', 'dist', 'index.js')).href)};

const root = mkdtempSync(join(tmpdir(), 'envseal-w7-ci-'));
writeFileSync(join(root, '.gitignore'), '.env\\n', 'utf8');
const broker = new Broker({ root });
await broker.declare({ entries: [{ key: 'W7_KEY', description: 'ci probe', required: true, secret: true }] });

let requestOutcome;
try {
  const ticket = await broker.request({ keys: ['W7_KEY'], reason: 'w7 ci probe' });
  requestOutcome = { threw: false, surface: ticket.surface, userMessage: ticket.userMessage, ticket: ticket.ticket };
} catch (err) {
  requestOutcome = { threw: true, code: err.code ?? null, name: err.name, message: err.message };
}
console.log('REQUEST ' + JSON.stringify(requestOutcome));

if (!requestOutcome.threw) {
  const outcome = await broker.await({ ticket: requestOutcome.ticket, timeoutMs: 5000 });
  console.log('AWAIT ' + JSON.stringify(outcome));
}
broker.dispose();
rmSync(root, { recursive: true, force: true });
process.exit(0);
`;

console.log('\n=== 2. env_request under CI=1 (hard 20s watchdog) ===');
{
  const childEnv = { ...process.env, CI: '1' };
  delete childEnv.SEP_PREFER_NATIVE;
  const r = runChild(REQUEST_SRC, childEnv);
  if (r.timedOut) {
    console.log(`  HANG: no result after ${HARD_TIMEOUT_MS}ms  <-- HIGH`);
  } else {
    console.log(`  exit=${r.code} in ${r.ms}ms`);
    for (const line of r.stdout.split('\n')) console.log('  ' + line);
    if (r.stderr) console.log('  stderr: ' + r.stderr.split('\n')[0]);
  }
}
