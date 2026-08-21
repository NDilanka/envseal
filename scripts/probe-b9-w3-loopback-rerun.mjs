// B9 — re-run probe-w3-loopback.mjs to completion.
//
// probe-w3-loopback.mjs section A10b calls `loadManifest(paths)` on a
// hand-written manifest with a hostile key name and expects `null` back. Since
// commit a6348d9 ("fail loudly on corrupt manifest") loadManifest THROWS
// SEP_FORMAT_INVALID instead, so the probe now aborts at A10b and never reaches
// A10c/A11/A12 or its own summary. That is a probe/product drift in
// manifest.ts, which belongs to another workstream — neither that file nor the
// probe is edited here.
//
// This wrapper copies the probe verbatim, wraps that ONE call in a try/catch
// (a throw is an even stronger rejection than `null`, so the assertion's intent
// is preserved), runs the copy, and deletes it. Everything else is byte-identical.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dir = import.meta.dirname;
const original = join(dir, 'probe-w3-loopback.mjs');
const patched = join(dir, 'probe-b9-w3-loopback.generated.mjs');

const NEEDLE = '  const loaded = loadManifest(paths);';
const REPLACEMENT = `  // PATCHED BY probe-b9-w3-loopback-rerun.mjs: loadManifest now throws
  // SEP_FORMAT_INVALID rather than returning null for a schema-invalid
  // manifest. Both outcomes mean "the key never reaches the prompter".
  let loaded;
  try {
    loaded = loadManifest(paths);
  } catch (err) {
    if (err?.code !== 'SEP_FORMAT_INVALID') throw err;
    loaded = null;
  }`;

const source = readFileSync(original, 'utf8');
if (!source.includes(NEEDLE)) {
  console.error(`probe-b9: anchor line not found in ${original}; refusing to guess.`);
  process.exit(2);
}
writeFileSync(patched, source.replace(NEEDLE, REPLACEMENT), 'utf8');
try {
  const r = spawnSync(process.execPath, [patched], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(patched, { force: true });
}
