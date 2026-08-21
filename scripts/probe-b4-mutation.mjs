// Mutation check for the B4 fix.
//
// A green exit-code test proves nothing unless it can go red. This reverts the
// fix — puts `process.exit(EXIT.VERIFY_FAILED)` back where `finish()` now is —
// rebuilds the CLI, and runs the verify contract test. That test MUST fail.
// Then it restores the file, rebuilds, and shows it green again.
//
// Usage: node scripts/probe-b4-mutation.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'packages', 'cli', 'src', 'commands', 'verify.ts');

const FIXED = `    if (!allOk) {
      finish(EXIT.VERIFY_FAILED);
      return;
    }`;
const BROKEN = `    if (!allOk) {
      process.exit(EXIT.VERIFY_FAILED);
    }`;

function sh(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

const build = () => sh('pnpm', ['--filter', '@envseal/cli', 'build']);
const runVerifyTest = () =>
  sh('pnpm', [
    '--filter',
    '@envseal/cli',
    'test',
    '--',
    '-t',
    'exits 6 on five consecutive runs with no libuv assertion',
  ]);

const original = readFileSync(target, 'utf8');
if (!original.includes(FIXED)) {
  console.error('FAIL: verify.ts does not contain the fixed block; nothing to mutate.');
  process.exit(1);
}

let mutatedFailed = false;
let restoredPassed = false;

try {
  console.log('--- mutating: finish(EXIT.VERIFY_FAILED) -> process.exit(EXIT.VERIFY_FAILED)');
  writeFileSync(target, original.replace(FIXED, BROKEN));
  const b1 = build();
  if (b1.status !== 0) {
    console.error(b1.stdout + b1.stderr);
    throw new Error('build of the mutated source failed');
  }

  const r1 = runVerifyTest();
  mutatedFailed = r1.status !== 0;
  console.log(`--- mutated test exit=${r1.status} (expected non-zero)`);
  console.log(
    (r1.stdout + r1.stderr)
      .split('\n')
      .filter((l) => /Tests\s|Test Files\s|×|AssertionError|expected/.test(l))
      .slice(0, 12)
      .join('\n'),
  );
} finally {
  console.log('--- restoring');
  writeFileSync(target, original);
  const b2 = build();
  if (b2.status !== 0) {
    console.error(b2.stdout + b2.stderr);
    console.error('FAIL: rebuild after restore failed');
    process.exit(1);
  }
  const r2 = runVerifyTest();
  restoredPassed = r2.status === 0;
  console.log(`--- restored test exit=${r2.status} (expected 0)`);
  console.log(
    (r2.stdout + r2.stderr)
      .split('\n')
      .filter((l) => /Tests\s|Test Files\s|✓/.test(l))
      .slice(0, 6)
      .join('\n'),
  );
}

if (mutatedFailed && restoredPassed) {
  console.log('MUTATION CHECK PASSED: the test goes red without the fix and green with it.');
  process.exit(0);
}
console.error(
  `MUTATION CHECK FAILED: mutatedFailed=${mutatedFailed} restoredPassed=${restoredPassed}`,
);
process.exit(1);
