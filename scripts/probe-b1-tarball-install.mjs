// Launch blocker B1 — prove every published tarball installs and runs.
//
// `npm publish` shipped `workspace:*` verbatim (EUNSUPPORTEDPROTOCOL on
// install); the release path now packs with pnpm, which rewrites those
// specifiers. Packing correctly is not the same as installing correctly,
// so this probe does what a customer would: `npm install <tgz>` into a
// directory containing nothing but a package.json, import the package's
// entry, and — for the two packages that ship binaries — execute the bin
// from an unrelated cwd and assert it did not scatter state there.
//
// Nothing is published, so a package's workspace dependencies are installed
// from their own tarballs in the same `npm install` command; npm satisfies
// the inter-package ranges against those file specs. Registry deps (zod,
// @modelcontextprotocol/sdk, ...) come from npm as they would for a user.
//
//   pnpm -r build && node scripts/probe-b1-tarball-install.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

// name -> {dir, deps (workspace only), importCheck [module, export], bin?}
const PACKAGES = {
  '@envseal/protocol': { dir: 'protocol', deps: [], importCheck: ['SEP_VERSION'] },
  '@envseal/registry': { dir: 'registry', deps: [], importCheck: ['allProviders'] },
  '@envseal/detector': { dir: 'detector', deps: ['@envseal/registry'], importCheck: ['detect'] },
  '@envseal/prompters': { dir: 'prompters', deps: ['@envseal/protocol'], importCheck: ['selectPrompter'] },
  '@envseal/core': {
    dir: 'core',
    deps: ['@envseal/protocol', '@envseal/registry', '@envseal/detector', '@envseal/prompters'],
    importCheck: ['Broker'],
  },
  '@envseal/sdk': {
    dir: 'sdk',
    deps: ['@envseal/protocol', '@envseal/core', '@envseal/prompters', '@envseal/registry'],
    importCheck: ['createBroker'],
  },
  '@envseal/mcp-server': {
    dir: 'mcp-server',
    deps: ['@envseal/protocol', '@envseal/core', '@envseal/prompters', '@envseal/registry'],
    importCheck: ['createServer'],
    bin: 'envseal-mcp',
  },
  '@envseal/http-server': {
    dir: 'http-server',
    deps: ['@envseal/protocol', '@envseal/core', '@envseal/prompters', '@envseal/sdk'],
    importCheck: ['startHttpServer'],
  },
  '@envseal/cli': {
    dir: 'cli',
    deps: [
      '@envseal/protocol',
      '@envseal/core',
      '@envseal/prompters',
      '@envseal/registry',
      '@envseal/detector',
      '@envseal/mcp-server',
      '@envseal/http-server',
    ],
    importCheck: ['exitCodeForOutcome'],
    bin: 'envseal',
  },
};

let failures = 0;
const fail = (name, msg) => {
  failures += 1;
  console.log(`  !! ${name}: ${msg}`);
};

const stage = join(tmpdir(), `envseal-b1-${Date.now()}`);
const packDir = join(stage, 'tgz');
const binsCwd = join(stage, 'bins-cwd');
mkdirSync(packDir, { recursive: true });
mkdirSync(binsCwd, { recursive: true });

function run(cmd, args, opts = {}) {
  // Windows intermittently fails to spawn (cmd.exe/node ENOENT, spawn UNKNOWN)
  // under memory pressure — status null with an `error`. That is infrastructure
  // flake, not a result; retry it rather than record a false pack/install failure.
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });
    if (!(last.status === null && last.error)) return last;
  }
  return last;
}

// Node >=20 refuses to spawn .cmd shims without a shell, and a shell mangles
// an args array. When the probe itself was started by pnpm, npm_execpath hands
// us pnpm's JS entry — same trick scripts/release.mjs uses. Otherwise fall
// back to a quoted shell string.
function pnpm(args, opts = {}) {
  const execpath = process.env.npm_execpath;
  if (execpath) {
    return run(process.execPath, [execpath, ...args], opts);
  }
  const line = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = spawnSync(`pnpm ${line}`, { encoding: 'utf8', shell: true, timeout: 300_000, ...opts });
    if (!(last.status === null && last.error)) return last;
  }
  return last;
}

// npm ships as a .cmd shim on Windows; like pnpm() above it needs a shell,
// and the args must be pre-joined and quoted.
function npm(args, opts = {}) {
  const line = ['npm', ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = spawnSync(line, { encoding: 'utf8', shell: true, timeout: 300_000, ...opts });
    if (!(last.status === null && last.error)) return last;
  }
  return last;
}

console.log('=== pnpm pack (the release path rewrites workspace:*) ===');
for (const [name, meta] of Object.entries(PACKAGES)) {
  const r = pnpm(['--filter', `./packages/${meta.dir}`, 'pack', '--pack-destination', packDir], {
    cwd: ROOT,
  });
  // Scoped packages pack as <scope>-<name>-<version>.tgz with the @ and / collapsed.
  const tgz = join(packDir, `${name.replace('@', '').replace('/', '-')}-0.1.0.tgz`);
  meta.tgz = tgz;
  if (r.status !== 0 || !existsSync(tgz)) {
    fail(name, `pack failed (status ${r.status}, error ${r.error?.message ?? 'none'}): ${(r.stderr || r.stdout || '').slice(-300)}`);
  }
}

console.log('=== npm install <tgz> into a bare dir, import, run bins ===');
for (const [name, meta] of Object.entries(PACKAGES)) {
  if (!meta.tgz || !existsSync(meta.tgz)) continue; // pack already failed
  const dir = join(stage, `install-${meta.dir}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'b1-probe', version: '0.0.0', private: true }));

  // Nothing is published, so every workspace dependency anywhere in the
  // transitive closure must be satisfied from its own tarball in the same
  // install command, or npm 404s resolving e.g. core's @envseal/detector range.
  const closure = new Set();
  const walk = (pkgName) => {
    for (const dep of PACKAGES[pkgName].deps) {
      if (!closure.has(dep)) {
        closure.add(dep);
        walk(dep);
      }
    }
  };
  walk(name);
  const depTgzs = [...closure].map((d) => PACKAGES[d].tgz);
  const install = npm(['install', '--no-audit', '--no-fund', '--loglevel=error', meta.tgz, ...depTgzs], {
    cwd: dir,
  });
  if (install.status !== 0) {
    fail(
      name,
      `npm install failed (status ${install.status}, error ${install.error?.message ?? 'none'}): ${(install.stderr || install.stdout || '').slice(-400)}`,
    );
    continue;
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
  const leaked = JSON.stringify(manifest.dependencies ?? {}).includes('workspace:');
  if (leaked) fail(name, 'installed manifest still carries workspace:*');

  const imp = run(
    process.execPath,
    [
      '-e',
      `import(${JSON.stringify(name)}).then(m => { const missing = ${JSON.stringify(meta.importCheck)}.filter(k => !(k in m)); if (missing.length) { console.error('MISSING_EXPORTS:' + missing.join(',')); process.exit(1); } console.log('EXPORTS_OK'); })`,
    ],
    { cwd: dir },
  );
  if (imp.status !== 0 || !imp.stdout.includes('EXPORTS_OK')) {
    fail(name, `import failed: ${(imp.stderr || imp.stdout || '').slice(-300)}`);
    continue;
  }

  if (meta.bin) {
    const binJs = join(dir, 'node_modules', ...name.split('/'), 'dist', 'bin.js');
    // Run from an unrelated cwd; a bin that scatters .envseal/ into cwd fails.
    const args = meta.bin === 'envseal' ? ['--version'] : ['--help'];
    const binRun = run(process.execPath, [binJs, ...args], { cwd: binsCwd });
    const out = `${binRun.stdout ?? ''}`;
    if (binRun.status !== 0 || out.trim() === '') {
      fail(name, `bin ${meta.bin} ${args.join(' ')} exited ${binRun.status}: ${(binRun.stderr || '').slice(-200)}`);
    }
    if (existsSync(join(binsCwd, '.envseal'))) {
      fail(name, `bin ${meta.bin} created .envseal/ in the invocation cwd`);
    }
    console.log(`  ${name}: install ok, imports {${meta.importCheck.join(', ')}}, bin ${meta.bin} -> ${out.trim().split(/\r?\n/)[0].slice(0, 60)}`);
  } else {
    console.log(`  ${name}: install ok, imports {${meta.importCheck.join(', ')}}`);
  }
}

const strayBins = existsSync(join(binsCwd, '.envseal'));
if (strayBins) rmSync(join(binsCwd, '.envseal'), { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });

if (failures > 0) {
  console.log(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('PASS: all 9 tarballs install from a bare dir, import, and their bins run clean');
