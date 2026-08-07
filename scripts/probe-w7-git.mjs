// W7 — git-safety gate on the dotenv sink.
//
// assertGitSafe() is the only thing standing between a written secret and a
// `git add -A`. Each case builds a throwaway project, drives a real write
// through the sink, and records both the error code and whether anything
// landed on disk. "Refused" is only a pass if nothing was written.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPaths, setDotenvValue } from '../packages/core/dist/index.js';

const SENTINEL = 'w7-sentinel-8f3a2c91';
const roots = [];

function newRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `envseal-w7-${name}-`));
  roots.push(root);
  return root;
}

function git(root, ...args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function initRepo(root) {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'w7@example.invalid');
  git(root, 'config', 'user.name', 'w7');
}

function attempt(root) {
  const paths = projectPaths(root);
  let error = null;
  try {
    setDotenvValue(paths, 'W7_KEY', SENTINEL, { description: 'w7 probe' });
  } catch (err) {
    error = { code: err.code ?? null, name: err.name, message: err.message };
  }
  const wrote = existsSync(paths.dotenv);
  const contains = wrote && readFileSync(paths.dotenv, 'utf8').includes(SENTINEL);
  return { error, wrote, contains };
}

function report(label, expected, r) {
  const verdict = r.error ? `THREW ${r.error.code ?? r.error.name}` : 'WROTE';
  console.log(`  ${label}`);
  console.log(`    expected : ${expected}`);
  console.log(`    observed : ${verdict}; .env exists=${r.wrote} containsSentinel=${r.contains}`);
  if (r.error && r.contains) console.log('    !! REFUSED BUT STILL WROTE THE SECRET  <-- HIGH');
}

console.log('=== W7 git-safety gate ===\n');

// 1. not a git repo at all
{
  const root = newRoot('nogit');
  report('1. project is not a git repo', 'write allowed (nothing to commit into)', attempt(root));
}

// 2. git repo, .env already tracked
{
  const root = newRoot('tracked');
  initRepo(root);
  writeFileSync(join(root, '.gitignore'), 'node_modules\n', 'utf8');
  writeFileSync(join(root, '.env'), 'PRE_EXISTING=keep-me\n', 'utf8');
  git(root, 'add', '--', '.env', '.gitignore');
  git(root, 'commit', '-q', '-m', 'track .env');
  const before = readFileSync(join(root, '.env'), 'utf8');
  const r = attempt(root);
  report('2. git repo with .env TRACKED', 'SEP_GITIGNORE_UNSAFE, no write', r);
  const after = readFileSync(join(root, '.env'), 'utf8');
  console.log(`    pre-existing .env preserved byte-for-byte: ${before === after}`);
}

// 3. git repo, no .gitignore at all
{
  const root = newRoot('nogitignore');
  initRepo(root);
  report('3. git repo, .gitignore MISSING', 'SEP_GITIGNORE_UNSAFE, no write', attempt(root));
}

// 4. git repo, .gitignore present but does not cover .env
{
  const root = newRoot('uncovered');
  initRepo(root);
  writeFileSync(join(root, '.gitignore'), 'node_modules\ndist\n', 'utf8');
  report('4. git repo, .gitignore does NOT cover .env', 'SEP_GITIGNORE_UNSAFE, no write', attempt(root));
}

// 5. happy path: git repo, .gitignore covers .env
{
  const root = newRoot('covered');
  initRepo(root);
  writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
  const r = attempt(root);
  report('5. git repo, .gitignore covers .env', 'write allowed', r);

  // The atomic-write temp file is `.<basename>.<hex>.tmp` — i.e. `..env.<hex>.tmp`.
  // A .gitignore entry of `.env` does not match it. If a crash or a failed
  // rename ever leaves one behind, the plaintext secret sits in the work tree
  // as an untracked, NON-ignored file that `git add -A` will happily stage.
  const tmpName = '..env.deadbeefcafe.tmp';
  writeFileSync(join(root, tmpName), `W7_KEY=${SENTINEL}\n`, 'utf8');
  let ignored;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', tmpName], { cwd: root, stdio: 'ignore' });
    ignored = true;
  } catch {
    ignored = false;
  }
  const status = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' });
  console.log(`\n  5b. leftover atomic-write temp file "${tmpName}"`);
  console.log(`    expected : covered by .gitignore just like .env`);
  console.log(`    observed : gitignored=${ignored}`);
  console.log(`    git status: ${JSON.stringify(status.trim().split('\n'))}`);
  if (!ignored) console.log('    !! plaintext secret in a stageable file  <-- HIGH');
}

// 6. does a refused write leave any stray file behind?
{
  const root = newRoot('stray');
  initRepo(root);
  attempt(root);
  console.log(`\n  6. files left in the project after a REFUSED write:`);
  console.log(`    ${JSON.stringify(readdirSync(root).filter((f) => f !== '.git'))}`);
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
