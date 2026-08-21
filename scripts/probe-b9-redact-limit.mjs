// B9 · W2-F9 follow-up — where is the ceiling of the *new* redactor?
//
// The old implementation compiled every prefix of every secret into one regex
// alternation (O(N^2) pattern source) and V8 aborted the process at ~4 KB. The
// replacement indexes 20-char windows in typed arrays, so the question is no
// longer "when does it abort" but "how much time and memory does it cost".
//
// Each length still runs in its own child, so a hypothetical fatal abort would
// be recorded rather than killing the probe. Two shapes of value are measured:
//   repetitive  — 'sk-' + 'A'*(n-3): every window is identical, the worst case
//                 for a hash-chained index.
//   random      — base64url alphabet: the realistic shape of a real credential.
// Both are redacted out of a 1 MB haystack, which is the exec buffer cap.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const coreUrl = pathToFileURL(join(import.meta.dirname, '../packages/core/dist/index.js')).href;
const protoUrl = pathToFileURL(join(import.meta.dirname, '../packages/protocol/dist/index.js')).href;

const child = `
const core = await import(${JSON.stringify(coreUrl)});
const proto = await import(${JSON.stringify(protoUrl)});
const n = Number(process.argv[1]);
const shape = process.argv[2];
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
let v;
if (shape === 'repetitive') {
  v = 'sk-' + 'A'.repeat(n - 3);
} else {
  // Deterministic LCG so runs are comparable.
  let s = 123456789;
  const out = new Array(n);
  // NB: take the HIGH bits. The low bits of an LCG mod 2^32 have period 2^k,
  // so 's % 64' would produce a string with period 64 rather than a random one.
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; out[i] = ALPHA[s >>> 26]; }
  v = out.join('');
}
const filler = 'x'.repeat(Math.max(0, 1024 * 1024 - v.length));
const haystack = filler.slice(0, filler.length >> 1) + v + filler.slice(filler.length >> 1);
const t0 = Date.now();
try {
  const r = core.redact(haystack, [proto.secretFromUtf8(v)]);
  const ms = Date.now() - t0;
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  // Also assert the >= 20 char prefix contract and the F5 newline split.
  const split = v.slice(0, 10) + '\\n' + v.slice(10);
  const r2 = core.redact(split, [proto.secretFromUtf8(v)]);
  const tailLeaks = v.length >= 40 && r2.text.includes(v.slice(30, 60));
  console.log(
    'OK count=' + r.count +
    ' leaked=' + r.text.includes(v) +
    ' prefix20leaked=' + r.text.includes(v.slice(0, 20)) +
    ' splitTailLeaked=' + tailLeaks +
    ' ms=' + ms + ' rssMB=' + rss,
  );
} catch (e) {
  console.log('THREW ' + e.constructor.name + ': ' + String(e.message).slice(0, 70));
}
`;

const LENGTHS = [4_000, 20_000, 100_000, 400_000, 1_000_000, 4_000_000];

for (const shape of ['repetitive', 'random']) {
  console.log(`\n=== ${shape} value, 1 MB haystack ===`);
  console.log('  bytes   exit  signal  result');
  for (const n of LENGTHS) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, String(n), shape], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const fatal = (r.stderr ?? '').split('\n').find((l) => /FATAL ERROR/.test(l));
    const out = fatal ? fatal.trim() : (r.stdout ?? '').trim() || (r.stderr ?? '').trim();
    console.log(
      `  ${String(n).padStart(7)}  ${String(r.status).padStart(4)}  ${String(r.signal ?? '-').padStart(6)}  ${out.slice(0, 110)}`,
    );
  }
}
