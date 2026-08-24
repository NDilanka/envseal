// W7 — filesystem failure modes on the dotenv sink.
//
// The sink claims atomicity: `.env` is written to a temp file, fsync'd, then
// renamed over the target, with a bounded retry loop because Windows renames
// intermittently fail under AV/indexer handles. This probe attacks that claim
// three ways — a read-only target, a target held open with FileShare.None by
// another process, and a process killed mid-write — and records what is left
// on disk each time.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectPaths, setDotenvValue, parseDotenv } from '../packages/core/dist/index.js';

const isWindows = process.platform === 'win32';
const SENTINEL = 'w7-fs-sentinel-4b7e';
const roots = [];

function newRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `envseal-w7-${name}-`));
  roots.push(root);
  return root;
}

function attempt(root, value) {
  const paths = projectPaths(root);
  try {
    setDotenvValue(paths, 'W7_KEY', value);
    return { threw: false };
  } catch (err) {
    return { threw: true, code: err.code ?? null, name: err.name, message: String(err.message).slice(0, 160) };
  }
}

function strays(root) {
  return readdirSync(root).filter((f) => f.endsWith('.tmp'));
}

console.log('=== W7 filesystem failure modes ===\n');

// --- 1. .env exists and is read-only ------------------------------------
{
  const root = newRoot('readonly');
  const envPath = join(root, '.env');
  writeFileSync(envPath, 'EXISTING=untouched\n', 'utf8');
  if (isWindows) spawnSync('attrib', ['+R', envPath]);
  else spawnSync('chmod', ['444', envPath]);

  const before = readFileSync(envPath, 'utf8');
  const r = attempt(root, SENTINEL);
  const after = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '<GONE>';

  console.log('1. .env is read-only');
  console.log('   expected : clean failure, file untouched, no plaintext left behind');
  console.log(`   observed : ${r.threw ? `THREW ${r.code ?? r.name}: ${r.message}` : 'WROTE (no error)'}`);
  console.log(`   file unchanged : ${before === after}`);
  console.log(`   contains secret: ${after.includes(SENTINEL)}`);
  console.log(`   stray .tmp files: ${JSON.stringify(strays(root))}`);
  if (isWindows) spawnSync('attrib', ['-R', envPath]);
  else spawnSync('chmod', ['644', envPath]);
  console.log();
}

// --- 2. .env held open by another process with FileShare.None -----------
if (isWindows) {
  const root = newRoot('locked');
  const envPath = join(root, '.env');
  writeFileSync(envPath, 'EXISTING=untouched\n', 'utf8');
  // Read the baseline BEFORE the exclusive handle exists — once it is held,
  // even reading the file fails with EBUSY.
  const before = readFileSync(envPath, 'utf8');

  // Hold an exclusive handle for 6s. This is the exact condition the rename
  // retry loop exists for; the loop's total budget is 1+2+5+10+25+50+100 =
  // 193ms, so a 6s hold outlasts every retry on purpose.
  const holder = spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$fs=[System.IO.File]::Open('${envPath.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Output READY; Start-Sleep -Seconds 6; $fs.Close()`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise((resolve) => {
    let seen = false;
    holder.stdout.on('data', (d) => {
      if (!seen && String(d).includes('READY')) {
        seen = true;
        resolve();
      }
    });
    setTimeout(resolve, 4000).unref();
  });

  const started = Date.now();
  const r = attempt(root, SENTINEL);
  const elapsed = Date.now() - started;
  const leftover = strays(root);
  holder.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '<GONE>';

  console.log('2. .env held open by another process (FileShare.None)');
  console.log('   expected : rename retries exhaust, clean throw, target intact, NO plaintext temp left');
  console.log(`   observed : ${r.threw ? `THREW ${r.code ?? r.name}: ${r.message}` : 'WROTE (no error)'} after ${elapsed}ms`);
  console.log(`   file unchanged : ${before === after}`);
  console.log(`   stray .tmp files: ${JSON.stringify(leftover)}`);
  for (const f of leftover) {
    const body = readFileSync(join(root, f), 'utf8');
    console.log(`     -> ${f} contains the secret: ${body.includes(SENTINEL)}`);
    if (body.includes(SENTINEL)) console.log('     !! plaintext secret left in the project dir  <-- HIGH');
  }
  console.log();

  // 2b. FileShare.Read: readFileIfPresent() succeeds, so the write reaches
  // renameOverwrite() and the retry loop is actually exercised. This is the
  // AV/indexer case the loop was written for.
  const root2 = newRoot('lockedread');
  const envPath2 = join(root2, '.env');
  writeFileSync(envPath2, 'EXISTING=untouched\n', 'utf8');
  const before2 = readFileSync(envPath2, 'utf8');
  const holder2 = spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$fs=[System.IO.File]::Open('${envPath2.replace(/'/g, "''")}','Open','Read','Read'); Write-Output READY; Start-Sleep -Seconds 6; $fs.Close()`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise((resolve) => {
    let seen = false;
    holder2.stdout.on('data', (d) => {
      if (!seen && String(d).includes('READY')) {
        seen = true;
        resolve();
      }
    });
    setTimeout(resolve, 4000).unref();
  });

  const started2 = Date.now();
  const r2 = attempt(root2, SENTINEL);
  const elapsed2 = Date.now() - started2;
  const leftover2 = strays(root2);
  holder2.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after2 = existsSync(envPath2) ? readFileSync(envPath2, 'utf8') : '<GONE>';

  console.log('2b. .env held open with FileShare.Read (rename retry loop exercised)');
  console.log('   expected : ~193ms of retries, then a clean throw; target intact; no plaintext temp left');
  console.log(`   observed : ${r2.threw ? `THREW ${r2.code ?? r2.name}: ${r2.message}` : 'WROTE (no error)'} after ${elapsed2}ms`);
  console.log(`   retry budget is 1+2+5+10+25+50+100 = 193ms; elapsed ${elapsed2}ms => retries ${elapsed2 >= 190 ? 'WERE' : 'were NOT'} exhausted`);
  console.log(`   file unchanged : ${before2 === after2}`);
  console.log(`   contains secret: ${after2.includes(SENTINEL)}`);
  console.log(`   stray .tmp files: ${JSON.stringify(leftover2)}`);
  for (const f of leftover2) {
    const body = readFileSync(join(root2, f), 'utf8');
    console.log(`     -> ${f} contains the secret: ${body.includes(SENTINEL)}`);
    if (body.includes(SENTINEL)) console.log('     !! plaintext secret left in the project dir  <-- HIGH');
  }
  console.log();
} else {
  console.log('2. .env held open — SKIPPED (Windows-only scenario)\n');
}

// --- 3. process killed mid-write ---------------------------------------
// The atomicity claim is that `.env` is never observed truncated. Run a child
// that rewrites `.env` in a tight loop alternating a short and a 200 KB value,
// SIGKILL it at a random moment, then check the survivor parses and holds one
// COMPLETE value. Repeat, because a single kill rarely lands in the window.
{
  const root = newRoot('crash');
  const envPath = join(root, '.env');
  // Payload and round count are tunable: a bigger value widens the window
  // between writeSync and renameSync, which is the only interval in which a
  // kill could plausibly leave a partial file behind.
  const PAYLOAD = Number(process.env.W7_CRASH_BYTES ?? 200_000);
  const ROUNDS = Number(process.env.W7_CRASH_ROUNDS ?? 15);
  const SHORT = 'short-value-aaaa';
  const LONG = 'L'.repeat(PAYLOAD);

  const childSrc = `
import { projectPaths, setDotenvValue } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'packages', 'core', 'dist', 'index.js')).href)};
const paths = projectPaths(process.argv[2]);
const SHORT = ${JSON.stringify(SHORT)};
const LONG = 'L'.repeat(${PAYLOAD});
for (let i = 0; ; i++) {
  setDotenvValue(paths, 'W7_KEY', i % 2 === 0 ? SHORT : LONG);
}
`;
  const childFile = join(root, 'writer.mjs');
  writeFileSync(childFile, childSrc, 'utf8');

  let truncated = 0;
  let unparseable = 0;
  let missingKey = 0;
  let strayWithSecret = 0;
  let strayTotal = 0;

  for (let round = 0; round < ROUNDS; round++) {
    for (const f of readdirSync(root)) {
      if (f === '.env' || f.endsWith('.tmp')) rmSync(join(root, f), { force: true });
    }
    const child = spawn(process.execPath, [childFile, root], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 120 + Math.floor(Math.random() * 400)));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));

    if (!existsSync(envPath)) continue;
    const text = readFileSync(envPath, 'utf8');
    let parsed;
    try {
      parsed = parseDotenv(text);
    } catch {
      unparseable++;
      continue;
    }
    const line = parsed.lines.find((l) => l.kind === 'assignment' && l.key === 'W7_KEY');
    if (!line) {
      missingKey++;
      continue;
    }
    // A complete write is exactly one of the two values. Anything else is a
    // partial write surviving the rename — which is what atomicity forbids.
    if (line.value !== SHORT && line.value !== LONG) truncated++;

    const s = readdirSync(root).filter((f) => f.endsWith('.tmp'));
    strayTotal += s.length;
    for (const f of s) {
      const body = readFileSync(join(root, f), 'utf8');
      if (body.includes(SHORT) || body.includes('LLLL')) strayWithSecret++;
      rmSync(join(root, f), { force: true });
    }
  }

  console.log(`3. process SIGKILLed mid-write (${ROUNDS} rounds, ${PAYLOAD} byte payload)`);
  console.log('   expected : .env always parses and always holds one COMPLETE value; no leftover plaintext temp');
  console.log(`   observed : truncated=${truncated} unparseable=${unparseable} keyMissing=${missingKey}`);
  console.log(`   leftover .tmp files across rounds: ${strayTotal} (containing plaintext: ${strayWithSecret})`);
  if (truncated + unparseable > 0) console.log('   !! ATOMICITY CLAIM BROKEN  <-- HIGH');
  else console.log('   atomicity claim HOLDS for the target file');
  if (strayWithSecret > 0) console.log('   !! crash leaves plaintext secrets in the project dir  <-- HIGH');
  console.log();
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
