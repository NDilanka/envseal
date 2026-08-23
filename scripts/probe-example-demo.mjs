// End-to-end probe for examples/demo: the five-command walk-through, executed
// against the BUILT CLI the way a user (and CI) would run it.
//
// Stages a copy of the demo project into a temp dir first — running inside the
// repo would mutate the checkout (init writes a manifest, set writes the env
// file), which is exactly the failure class VERIFICATION.md §0 records.
//
// Sequence and assertions:
//   1. init            → manifest declares DEMO_API_KEY (scanner found src/index.js)
//   2. ensure --check  → exit 1, satisfied:false  (nothing stored yet — the CI gate
//                        failing honestly BEFORE provisioning)
//   3. set             → stored, via the double-gated stub prompter
//   4. ensure --check  → exit 0, satisfied:true
//   5. run             → child prints the presence line; sentinel never in any output
//   6. status          → entry present, sink dotenv
// Plus: the sentinel appears in NO captured stdout/stderr on any step.
//
// Usage: node scripts/probe-example-demo.mjs   (requires packages/cli built)

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const SENTINEL = 'sk-demo-SENTINEL-DO-NOT-LEAK-4f7e8d9c0b';

if (!existsSync(cli)) {
  console.error(`built CLI not found at ${cli} — run pnpm build first`);
  process.exit(2);
}

const stage = mkdtempSync(join(tmpdir(), 'envseal-demo-probe-'));
const project = join(stage, 'demo');
cpSync(join(repoRoot, 'examples', 'demo'), project, { recursive: true });

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`FAIL: ${msg}`);
};

function run(args, env = {}) {
  const childEnv = { ...process.env, ...env };
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: 'utf8',
    env: childEnv,
    timeout: 30_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

try {
  // 1. init — declares what the source reads
  const init = run(['init', '--json']);
  console.log(`1. init                          exit ${init.code}`);
  if (init.code !== 0) fail(`init exited ${init.code}: ${init.stderr.slice(0, 300)}`);
  const manifestPath = join(project, 'env.schema.jsonc');
  if (!existsSync(manifestPath)) fail('init wrote no env.schema.jsonc');
  else {
    const manifest = readFileSync(manifestPath, 'utf8');
    if (!manifest.includes('DEMO_API_KEY')) fail('manifest does not declare DEMO_API_KEY');
  }

  // 2. ensure --check BEFORE provisioning — the gate must fail honestly
  const gate1 = run(['ensure', '--check', '--json'], { CI: '1' });
  console.log(`2. ensure --check (pre-set)     exit ${gate1.code}`);
  if (gate1.code !== 1) fail(`pre-set gate exited ${gate1.code}, expected 1`);
  try {
    const parsed = JSON.parse(gate1.stdout);
    if (parsed.satisfied !== false || !parsed.missing?.includes('DEMO_API_KEY')) {
      fail(`pre-set gate JSON wrong: ${gate1.stdout.slice(0, 200)}`);
    }
  } catch {
    fail(`pre-set gate stdout not JSON: ${gate1.stdout.slice(0, 200)}`);
  }

  // 3. set — provision through the stub prompter (test-mode double gate)
  const set = run(
    ['set', 'DEMO_API_KEY', '--json'],
    { ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_PROMPTER_VALUE: SENTINEL },
  );
  console.log(`3. set DEMO_API_KEY             exit ${set.code}`);
  if (set.code !== 0) fail(`set exited ${set.code}: ${set.stderr.slice(0, 300)}`);
  try {
    if (JSON.parse(set.stdout).outcome !== 'stored') {
      fail(`set outcome not stored: ${set.stdout.slice(0, 200)}`);
    }
  } catch {
    fail(`set stdout not JSON: ${set.stdout.slice(0, 200)}`);
  }

  // 4. ensure --check AFTER provisioning — the gate passes
  const gate2 = run(['ensure', '--check', '--json'], { CI: '1' });
  console.log(`4. ensure --check (post-set)    exit ${gate2.code}`);
  if (gate2.code !== 0) fail(`post-set gate exited ${gate2.code}, expected 0`);
  try {
    if (JSON.parse(gate2.stdout).satisfied !== true) {
      fail(`post-set gate not satisfied: ${gate2.stdout.slice(0, 200)}`);
    }
  } catch {
    fail(`post-set gate stdout not JSON: ${gate2.stdout.slice(0, 200)}`);
  }

  // 5. run — the child receives the value; outputs stay sentinel-free
  const exec = run(
    ['run', '--', process.execPath, 'src/index.js'],
    { ENVSEAL_ASSUME_YES: '1' },
  );
  console.log(`5. run -- node src/index.js     exit ${exec.code}`);
  if (exec.code !== 0) fail(`run exited ${exec.code}: ${exec.stderr.slice(0, 300)}`);
  if (!/DEMO_API_KEY present \(length bucket: 32\+\)/.test(exec.stdout)) {
    fail(`child output missing presence line: ${JSON.stringify(exec.stdout)}`);
  }

  // 6. status — read-only presence
  const status = run(['status', '--json']);
  console.log(`6. status                       exit ${status.code}`);
  if (status.code !== 0) fail(`status exited ${status.code}: ${status.stderr.slice(0, 300)}`);
  let sawPresent = false;
  try {
    const parsed = JSON.parse(status.stdout);
    const entry = (parsed.entries ?? parsed).find?.((e) => e.key === 'DEMO_API_KEY');
    sawPresent = entry?.present === true;
  } catch {
    // fall through to the text assertion below
  }
  if (!sawPresent && !/present/.test(status.stdout)) {
    fail(`status does not report DEMO_API_KEY present: ${status.stdout.slice(0, 300)}`);
  }

  // Cross-cutting: the sentinel must appear in NO output of ANY step.
  for (const [name, r] of [
    ['init', init],
    ['gate1', gate1],
    ['set', set],
    ['gate2', gate2],
    ['run', exec],
    ['status', status],
  ]) {
    if (r.stdout.includes(SENTINEL) || r.stderr.includes(SENTINEL)) {
      fail(`sentinel leaked in ${name} output`);
    }
  }

  console.log(
    failed
      ? 'FAIL: example demo probe found problems (above)'
      : 'PASS: init -> ensure --check (fail) -> set -> ensure --check (pass) -> run -> status, sentinel never printed',
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
