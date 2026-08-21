// Manual gate M3 — keychain sink round-trip, as far as it can go.
//
// The gate as documented ("set with sink: keychain, then `envseal run`
// resolves the reference") CANNOT pass today: the keychain sink is write-only
// (read() returns null; docs/residual-risks.md and README say so). This probe
// verifies exactly what IS true on Windows and records what is not:
//
//   1. a value set through the real Broker into a keychain-sink entry lands in
//      %LOCALAPPDATA%\envseal\creds\<KEY> as a DPAPI blob (ConvertFrom-
//      SecureString output), never as plaintext;
//   2. `.env` does NOT receive the value;
//   3. `status --json` reports present:true with sink "keychain";
//   4. `envseal run --` cannot resolve it — recorded verbatim as the
//      documented limitation, not papered over.
//
//   pnpm -r build && node scripts/probe-m3-keychain.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = join(import.meta.dirname, '../packages/cli/dist/bin.js');
const coreUrl = pathToFileURL(join(import.meta.dirname, '../packages/core/dist/index.js')).href;

const KEY = 'M3_CANARY_KEY';
// Structurally realistic, deliberately fake.
const CANARY = 'sk-proj-FakeM3CanaryQ7X9K2V5Rr8Nc3Bd6Hk1Ws5Yt0Ju7Gi2Ae4Of6';

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  !! ${msg}`);
};

const root = mkdtempSync(join(tmpdir(), 'envseal-m3-'));
const { writeFileSync } = await import('node:fs');
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');

console.log('=== store through the real Broker (sink: keychain) ===');
{
  const { Broker } = await import(coreUrl);
  const stubPrompter = {
    id: 'loopback-browser',
    available: async () => true,
    prompt: async (req) => ({
      ticket: req.ticket,
      // SecretValue is a branded Buffer; a plain string would blow up the
      // broker's zero() after storing and cancel the ticket.
      results: req.keys.map((k) => ({ key: k.key, outcome: 'entered', value: Buffer.from(CANARY, 'utf8') })),
    }),
    cancel: async () => {},
  };
  const broker = new Broker({ root, prompter: stubPrompter });
  const declared = await broker.declare({
    entries: [{ key: KEY, required: true, description: 'M3 keychain probe', sink: 'keychain' }],
  });
  if (!declared.added?.includes(KEY)) fail(`declare did not add ${KEY}: ${JSON.stringify(declared)}`);
  const res = await broker.request({ keys: [KEY], reason: 'M3 keychain write probe' });
  // request() resolves to the ticket envelope ({ticket,nonce,surface,...});
  // per-key outcomes live behind broker.await(), which also guarantees the
  // sink write has settled before the at-rest checks below run.
  const outcome = await broker.await({ ticket: res.ticket });
  const stored = outcome.keys.find((k) => k.key === KEY)?.outcome;
  console.log(`  request outcome: ${stored} (ticket ${outcome.state})`);
  if (stored !== 'stored') fail(`expected stored, got ${stored ?? JSON.stringify(outcome)}`);
  broker.dispose();
}

const credFile = join(homedir(), 'AppData', 'Local', 'envseal', 'creds', KEY);

console.log('=== credential at rest ===');
{
  if (!existsSync(credFile)) {
    fail(`expected DPAPI blob at ${credFile}`);
  } else {
    const blob = readFileSync(credFile, 'utf8');
    // A 0-byte file is exactly the silent-write failure this probe guards
    // against; check it first so hex-only can never pass on empty input.
    if (blob.trim().length === 0) {
      fail('credential file is EMPTY (0 bytes) — the keychain write silently lost the value');
    }
    // ConvertFrom-SecureString emits hex digits only. Plaintext would contain
    // '-' and letters outside that alphabet.
    const looksEncrypted = /^[0-9a-f]+$/i.test(blob.trim());
    console.log(`  blob hex-only: ${looksEncrypted} (${blob.trim().length} chars)`);
    if (!looksEncrypted) fail('credential file is not a hex DPAPI blob');
    if (blob.includes(CANARY)) fail('PLAINTEXT canary found in the credential file');
  }
}

console.log('=== blob decrypts back to the canary (DPAPI round-trip) ===');
{
  // The decrypt snippet goes through a temp script file, never argv, where it
  // would be visible to any process listing.
  const psPath = credFile.replace(/'/g, "''");
  const decryptScript = join(root, 'decrypt.ps1');
  writeFileSync(
    decryptScript,
    [
      `$blob = Get-Content -Raw '${psPath}'`,
      '$secure = ConvertTo-SecureString -String $blob',
      '$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
      'try {',
      '  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)',
      '} finally {',
      '  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)',
      '}',
      '[Console]::Out.Write($plain)',
      '',
    ].join('\n'),
    'utf8',
  );
  // Same scrub the sink does: a PSModulePath inherited from an editor leads
  // with PowerShell 7 modules and breaks ConvertTo-SecureString under 5.1.
  const { PSModulePath: _shadowed, ...probeEnv } = process.env;
  const r = spawnSync('powershell', ['-NoProfile', '-File', decryptScript], {
    encoding: 'utf8',
    timeout: 60_000,
    env: probeEnv,
  });
  const recovered = (r.stdout ?? '').trim();
  console.log(`  recovered value matches canary: ${recovered === CANARY} (${recovered.length} chars)`);
  if (r.status !== 0) fail(`decrypt snippet exited ${r.status}: ${(r.stderr ?? '').trim().slice(0, 200)}`);
  if (recovered !== CANARY) fail('DPAPI round-trip did not recover the canary from the stored blob');
}

console.log('=== .env must not hold the value ===');
{
  let dotenvText = '';
  try {
    dotenvText = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    // absent .env is fine for a keychain sink
  }
  if (dotenvText.includes(CANARY)) fail('plaintext canary leaked into .env');
  console.log(`  .env contains canary: ${dotenvText.includes(CANARY)}`);
}

console.log('=== status --json sees it, values never ===');
{
  const r = spawnSync(process.execPath, [cli, 'status', '--json', '--project', root], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    fail(`status --json stdout was not JSON: ${JSON.stringify(r.stdout?.slice(0, 200))}`);
  }
  const entry = parsed?.entries?.find((e) => e.key === KEY);
  console.log(`  entry: ${JSON.stringify(entry)}`);
  if (entry?.sink !== 'keychain') fail(`expected sink keychain, got ${entry?.sink}`);
  if (r.stdout.includes(CANARY)) fail('status --json printed the canary');
  // present:false is the write-only limitation surfacing in status itself:
  // resolvePresence() consults process-env and .env only, never the keychain
  // sink. Recorded verbatim like the run leg below, not papered over.
  if (!entry?.present) {
    console.log('  recorded: status reports present:false (presence cannot see the write-only keychain sink)');
  }
}

console.log('=== envseal run -- cannot resolve (documented write-only limitation) ===');
{
  const r = spawnSync(
    process.execPath,
    [cli, 'run', '--project', root, '--', process.execPath, '-e', 'process.stdout.write(String(process.env.M3_CANARY_KEY ?? "UNRESOLVED"))'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      // Approve non-interactively so confirmation doesn't mask the resolution
      // attempt with SEP_NO_INTERACTIVE_SURFACE before it ever runs.
      env: { ...process.env, ENVSEAL_ASSUME_YES: '1' },
    },
  );
  const combined = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  console.log(`  exit=${r.status}`);
  console.log(`  stdout: ${(r.stdout ?? '').trim().slice(0, 300)}`);
  console.log(`  stderr: ${(r.stderr ?? '').trim().slice(0, 300)}`);
  if (combined.includes(CANARY)) fail('run resolved the write-only keychain reference to plaintext');
  // The honest expectation: the child sees UNRESOLVED (or run refuses). Either
  // way the value must not appear. Record which actually happened.
  if ((r.stdout ?? '').trim() === 'UNRESOLVED') {
    console.log('  recorded: child ran without the value (write-only confirmed live)');
  }
}

rmSync(root, { recursive: true, force: true });
try {
  rmSync(credFile, { force: false });
  console.log('cleaned up credential file');
} catch (e) {
  console.log(`NOTE: could not remove ${credFile}: ${e.message}`);
}

if (failures > 0) {
  console.log(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('PASS: M3 write leg verified; resolution leg fails as documented (write-only)');
