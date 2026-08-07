// W2 · F9 — how large a stored value can be before `redact()` kills the process.
//
// redact() builds one alternation containing every prefix of length 20..N of
// every live secret (redact.ts:25-27, joined at line 48), so the regex source
// grows as O(N^2). Past a threshold V8's regex compiler does not throw a
// catchable SyntaxError — it aborts the process.
//
// Each length runs in its own child, because the failure mode is fatal.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const coreUrl = pathToFileURL(join(import.meta.dirname, '../packages/core/dist/index.js')).href;
const protoUrl = pathToFileURL(join(import.meta.dirname, '../packages/protocol/dist/index.js')).href;

const child = `
const core = await import(${JSON.stringify(coreUrl)});
const proto = await import(${JSON.stringify(protoUrl)});
const v = process.argv[1];
try {
  const r = core.redact('before ' + v + ' after', [proto.secretFromUtf8(v)]);
  console.log('OK count=' + r.count + ' leaked=' + r.text.includes(v));
} catch (e) {
  console.log('THREW ' + e.constructor.name + ': ' + String(e.message).slice(0, 60));
}
`;

console.log('  bytes   exit  signal  result');
for (const n of [100, 500, 1000, 2000, 3000, 3500, 4000, 5000]) {
  const value = 'sk-' + 'A'.repeat(n - 3);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, value], {
    encoding: 'utf8',
  });
  const fatal = (r.stderr ?? '').split('\n').find((l) => /FATAL ERROR/.test(l));
  const out = fatal ? fatal.trim() : (r.stdout ?? '').trim();
  console.log(
    `  ${String(n).padStart(5)}  ${String(r.status).padStart(4)}  ${String(r.signal ?? '-').padStart(6)}  ${out.slice(0, 80)}`,
  );
}
