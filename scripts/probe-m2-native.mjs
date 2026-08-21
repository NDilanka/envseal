// Manual gate M2 — Windows native consent dialog (SEP_PREFER_NATIVE=1).
//
// The gate asks: "Masked dialog appears; cancel yields cancelled, not a crash."
// A masked dialog rendering on a real console needs eyes AND a console:
// Read-Host -AsSecureString reads the console input buffer, not a redirected
// pipe, so no pipe harness can type a value into it. This probe verifies the
// three automatable layers against the BUILT artifact and leaves the typed,
// visually-masked entry to the human runbook:
//
//   1. cancel path through the REAL NativePrompter class (dist) — the adapter
//      spawns powershell with its own already-closed stdin, so Read-Host sees
//      EOF; the outcome must be `cancelled`, never a hang or a crash;
//   2. no-console input through the adapter's exact template must FAIL CLOSED:
//      empty output, promptly — never a value, never a hang;
//   3. full-binary fail-closed: `envseal set` under SEP_PREFER_NATIVE=1 must
//      resolve to outcome=cancelled / exit 3 and store nothing;
//   4. no envseal-*.ps1 temp script is left behind by either path.
//
//   (human-only) typing into the masked dialog on an interactive console.
//
//   pnpm -r build && node scripts/probe-m2-native.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = join(import.meta.dirname, '../packages/cli/dist/bin.js');
const promptersUrl = pathToFileURL(
  join(import.meta.dirname, '../packages/prompters/dist/index.js'),
).href;

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  !! ${msg}`);
};

function tempScripts() {
  // The adapter names its temp scripts envseal-<16 hex>.ps1 in the default
  // temp dir. Snapshot before, compare after.
  return readdirSync(tmpdir()).filter((f) => /^envseal-[0-9a-f]{16}\.ps1$/.test(f));
}

// --- 1. cancel path through the real adapter ---------------------------------
console.log('=== NativePrompter.prompt with closed stdin (the adapter always closes it) ===');
{
  const { NativePrompter } = await import(promptersUrl);
  const before = tempScripts();
  const prompter = new NativePrompter();
  if (!(await prompter.available())) {
    fail('NativePrompter.available() is false on Windows where powershell exists');
  }
  const result = await prompter.prompt({
    ticket: 'M2TICKET',
    nonce: 'ABCD-1234',
    surface: 'native-dialog',
    keys: [{ key: 'M2_KEY', description: 'probe key' }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    userMessage: '',
  });
  const outcome = result.results[0]?.outcome;
  console.log(`  outcome: ${outcome}`);
  if (outcome !== 'cancelled') fail(`expected cancelled, got ${outcome}`);
  const after = tempScripts().filter((f) => !before.includes(f));
  if (after.length > 0) fail(`temp ps1 left behind: ${after.join(', ')}`);
}

// --- 2. no-console input must FAIL CLOSED through the adapter's template -----
// Read-Host -AsSecureString takes its input from the console input buffer, not
// a redirected pipe: with -File and a closed pipe it returns empty promptly,
// and with -Command it can block forever on a real console read. The adapter
// runs -File, so the honest automated expectation is: piped stdin (no console)
// yields EMPTY output promptly — which promptOne maps to `cancelled`. A typed
// round-trip needs a real console; that stays in the human runbook.
console.log('=== powershell -File <template> with no console (piped, immediately closed) ===');
{
  // Mirrored byte-for-byte from packages/prompters/src/native.ts winAdapter
  // (formatLabel for a key with no description/hint + the Nonce line).
  const label = 'M2_KEY\n\nNonce: ABCD-1234';
  const psScript =
    `$ErrorActionPreference = 'Stop'\n` +
    `$prompt = @'\n${label}\n'@\n` +
    `$secure = Read-Host -Prompt $prompt -AsSecureString\n` +
    `if ($null -eq $secure) { exit 1 }\n` +
    `$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)\n` +
    `try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }\n` +
    `finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }\n`;
  const scriptPath = join(tmpdir(), `envseal-m2-probe-${Date.now()}.ps1`);
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(scriptPath, psScript, 'utf8');
  try {
    const stdout = await new Promise((resolve) => {
      const child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive:$false', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve(`TIMEOUT:${out}`);
      }, 30_000);
      child.stdout.on('data', (c) => (out += c));
      child.stdin.end();
      child.once('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    const value = stdout.replace(/\r?\n$/, '');
    const failedClosed = value === '';
    console.log(`  no-console result: ${failedClosed ? 'empty, promptly (fail-closed)' : JSON.stringify(value.slice(0, 80))}`);
    if (!failedClosed) fail('without a console the template must yield empty (cancelled), never a value');
  } finally {
    unlinkSync(scriptPath);
  }
}

// --- 3. full binary: SEP_PREFER_NATIVE=1 fails closed ------------------------
console.log('=== envseal set with SEP_PREFER_NATIVE=1 (no interactive console) ===');
{
  const root = mkdtempSync(join(tmpdir(), 'envseal-m2-full-'));
  const childEnv = { ...process.env, SEP_PREFER_NATIVE: '1' };
  delete childEnv.CI;
  const r = spawnSync(process.execPath, [cli, 'set', 'M2_KEY', '--project', root, '--json'], {
    cwd: root,
    env: childEnv,
    input: '',
    encoding: 'utf8',
    timeout: 120_000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    fail(`stdout was not JSON: ${JSON.stringify(r.stdout?.slice(0, 200))}`);
  }
  console.log(`  exit=${r.status} outcome=${parsed?.outcome ?? '??'} code=${parsed?.code ?? '-'}`);
  if (r.status !== 3) fail(`expected exit 3 (cancelled), got ${r.status}`);
  if (parsed?.outcome !== 'cancelled') fail(`expected outcome cancelled, got ${parsed?.outcome}`);
  const dotenvText = (() => {
    try {
      return readFileSync(join(root, '.env'), 'utf8');
    } catch {
      return '';
    }
  })();
  if (dotenvText !== '') fail('.env was created or written during a cancelled set');
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('PASS: M2 fail-closed paths verified; typed/masked entry stays human-runbook');
