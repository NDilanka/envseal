#!/usr/bin/env node
// The one supported way to publish envseal.
//
// `npm publish` cannot release this repo: it ships pnpm's `workspace:*` protocol verbatim and
// every install of the resulting tarball fails with EUNSUPPORTEDPROTOCOL. Only `pnpm publish`
// rewrites those specifiers to the concrete version. This script is the release path, and it
// checks the artifact rather than trusting the manifest: it packs every package and greps the
// packed manifests for a surviving `workspace:` before anything is uploaded.
//
// Usage:
//   pnpm release --dry-run    preflight only, nothing is uploaded
//   pnpm release              preflight, then `pnpm -r publish`
//
// Provenance: npm generates the attestation, so it needs an OIDC token. That only exists in the
// release workflow (.github/workflows/release.yml, `permissions: id-token: write`). Each package
// sets `publishConfig.provenance: true`, so a publish from a laptop fails loudly rather than
// shipping an unattested tarball. See docs/publishing.md.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const skipBuild = process.argv.includes('--skip-build');

const git = process.platform === 'win32' ? 'git.exe' : 'git';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    ...opts,
  });
}

// Node >=20 refuses to spawn a .cmd shim without a shell, so go through pnpm's own JS entry
// point instead of the `pnpm.cmd` wrapper. npm_execpath is set for us because this script is
// always started by pnpm (checked below).
function pnpm(args, opts = {}) {
  const execpath = process.env.npm_execpath;
  return execpath
    ? run(process.execPath, [execpath, ...args], opts)
    : run('pnpm', args, { ...opts, shell: true });
}

// Minimal tar reader. Shelling out to `tar` is not portable enough for a release gate: the GNU
// tar that ships with Git for Windows reads `C:\...` as a remote host spec and fails outright.
function readTar(tgzPath) {
  const buf = gunzipSync(readFileSync(tgzPath));
  const entries = new Map();
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (name === '') break; // end-of-archive
    const prefix = buf.toString('utf8', off + 345, off + 500).replace(/\0.*$/, '');
    const size = parseInt(buf.toString('ascii', off + 124, off + 135).trim() || '0', 8);
    const type = buf.toString('ascii', off + 156, off + 157);
    const full = prefix ? `${prefix}/${name}` : name;
    const body = off + 512;
    if (type === '0' || type === '\0') entries.set(full, buf.subarray(body, body + size));
    off = body + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function fail(msg) {
  process.stderr.write(`\nrelease: ${msg}\n\n`);
  process.exit(1);
}

function step(msg) {
  process.stdout.write(`\n== ${msg}\n`);
}

// --- 1. the release must be driven by pnpm -----------------------------------------------
const ua = process.env.npm_config_user_agent ?? '';
if (!ua.startsWith('pnpm/')) {
  fail(
    `run this through pnpm (\`pnpm release\`), not ${ua.split(' ')[0] || 'a bare node'}.\n` +
      `        only pnpm rewrites the \`workspace:\` protocol on publish.`,
  );
}

// --- 2. which packages are we releasing? -------------------------------------------------
const publishable = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(ROOT, 'packages', d.name))
  .filter((dir) => {
    try {
      return !JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).private;
    } catch {
      return false; // no package.json (packages/examples is a container, not a package)
    }
  });

step(`releasing ${publishable.length} packages`);
for (const dir of publishable) {
  const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  process.stdout.write(`   ${m.name}@${m.version}\n`);
  if (m.publishConfig?.access !== 'public') {
    fail(`${m.name} is missing publishConfig.access="public"; npm would reject the first publish of a new scope.`);
  }
}

// --- 3. clean tree, right branch ---------------------------------------------------------
step('git state');
const status = run(git, ['status', '--porcelain'], { capture: true });
if (status.trim() && !dryRun) {
  fail(`working tree is dirty; commit or stash first:\n${status}`);
}
const branch = run(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).trim();
process.stdout.write(`   branch ${branch}, tree ${status.trim() ? 'dirty' : 'clean'}\n`);

// --- 4. build ----------------------------------------------------------------------------
if (!skipBuild) {
  step('pnpm -r build');
  pnpm(['-r', 'build']);
}

// --- 5. pack, and check the artifact, not the manifest -----------------------------------
step('packing and inspecting tarballs');
const out = mkdtempSync(join(tmpdir(), 'envseal-release-'));
let bad = 0;
try {
  for (const dir of publishable) {
    pnpm(['pack', '--pack-destination', out], { cwd: dir, capture: true });
  }
  for (const tgz of readdirSync(out)) {
    const entries = readTar(join(out, tgz));
    const manifest = entries.get('package/package.json')?.toString('utf8');
    if (manifest === undefined) {
      bad++;
      process.stderr.write(`   FAIL ${tgz}: no package/package.json in the tarball\n`);
      continue;
    }
    const hits = [...manifest.matchAll(/"([^"]+)":\s*"(workspace:[^"]*)"/g)];
    if (hits.length > 0) {
      bad++;
      process.stderr.write(`   FAIL ${tgz}: ${hits.map((h) => `${h[1]} -> ${h[2]}`).join(', ')}\n`);
      continue;
    }
    // maps have no sourcesContent and src/ is not shipped, so any map here is dangling
    const maps = [...entries.keys()].filter((f) => f.endsWith('.map'));
    if (maps.length > 0) {
      bad++;
      process.stderr.write(`   FAIL ${tgz}: ${maps.length} dangling source map(s)\n`);
      continue;
    }
    process.stdout.write(`   ok   ${tgz} (${entries.size} files, no workspace:, no maps)\n`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (bad > 0) {
  fail(`${bad} tarball(s) still carry the \`workspace:\` protocol. Do not publish.`);
}

// --- 6. publish --------------------------------------------------------------------------
if (dryRun) {
  step('--dry-run: preflight passed, nothing published');
  process.exit(0);
}

step('pnpm -r publish');
pnpm(['-r', 'publish', '--access', 'public', '--publish-branch', branch]);
