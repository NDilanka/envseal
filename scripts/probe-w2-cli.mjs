// W2 · CLI binding (Tier 4): run every command as a real child process against
// a project that already holds a value, and sweep the combined stdout+stderr.
//
// CI=1 is forced so `selectPrompter` resolves to `none` (registry.ts:47) rather
// than opening a real browser window.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SENTINEL = 'sk-W2SENTINEL-cli-eeeeffff00001111';
const SHORT = 'shortie'; // 7 bytes — below the redactor's MIN_SECRET_LENGTH
const BIN = resolve(import.meta.dirname, '../packages/cli/dist/bin.js');

const root = mkdtempSync(join(tmpdir(), 'envseal-w2-cli-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
writeFileSync(join(root, '.env'), `OPENAI_API_KEY=${SENTINEL}\nSHORT_KEY=${SHORT}\n`, 'utf8');
writeFileSync(
  join(root, 'env.schema.jsonc'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        {
          key: 'OPENAI_API_KEY',
          description: 'W2 cli probe',
          required: true,
          secret: true,
          sink: 'dotenv',
          verify: {
            method: 'GET',
            url: 'https://api.openai.com/v1/models',
            headerTemplate: { Authorization: 'Bearer {{value}}' },
            expectStatus: [200],
          },
        },
        { key: 'SHORT_KEY', description: 'seven bytes', required: true, secret: true, sink: 'dotenv' },
      ],
    },
    null,
    2,
  ),
  'utf8',
);

const transcript = [];

// `bin.ts:32` takes argv[0] as the command, so global flags go AFTER it.
// The first element of `args` is the subcommand (or a bare global flag).
function cli(label, args, extraEnv = {}) {
  const argv = args[0]?.startsWith('-') ? [...args] : [args[0], '--project', root, ...args.slice(1)];
  const r = spawnSync(process.execPath, [BIN, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, CI: '1', ...extraEnv },
    timeout: 60000,
  });
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  transcript.push({ label, args, combined, code: r.status });
  const leak = combined.includes(SENTINEL);
  console.log(
    `  ${label.padEnd(40)} exit=${String(r.status).padStart(3)} leak=${String(leak).padEnd(5)} ${combined.slice(0, 100).replace(/\s+/g, ' ')}`,
  );
  return r;
}

console.log('=== every documented command ===');
cli('status', ['status']);
cli('status --json', ['status', '--json']);
cli('doctor', ['doctor']);
cli('doctor --json', ['doctor', '--json']);
cli('verify --json', ['verify', '--json']);
cli('init --json', ['init', '--json']);
cli('--version', ['--version']);
cli('--help', ['--help']);

console.log('=== run: child echoes the value in many shapes ===');
const echo = join(root, 'echo.mjs');
writeFileSync(
  echo,
  `const v = process.env.OPENAI_API_KEY ?? '';
const s = process.env.SHORT_KEY ?? '';
console.log('plain=' + v);
console.log('b64=' + Buffer.from(v).toString('base64'));
console.log('hex=' + Buffer.from(v).toString('hex'));
console.log('split=' + v.slice(0,12) + '\\n' + v.slice(12));
console.log('short=' + s);
console.error('stderr=' + v);
`,
  'utf8',
);
cli('run -- node echo.mjs', ['run', '--yes', '--', process.execPath, echo], {
  ENVSEAL_ASSUME_YES: '1',
});
cli('run --json -- node echo.mjs', ['run', '--yes', '--json', '--', process.execPath, echo], {
  ENVSEAL_ASSUME_YES: '1',
});

console.log('=== run: child floods past the 1 MiB stdout cap, value at the end ===');
const flood = join(root, 'flood.mjs');
writeFileSync(
  flood,
  `const v = process.env.OPENAI_API_KEY ?? '';
process.stdout.write('P'.repeat(1024 * 1024 - 20));
process.stdout.write(v + '\\n');
`,
  'utf8',
);
const floodRes = cli('run -- node flood.mjs (1 MiB cap)', ['run', '--yes', '--json', '--', process.execPath, flood], {
  ENVSEAL_ASSUME_YES: '1',
});
{
  const out = `${floodRes.stdout ?? ''}${floodRes.stderr ?? ''}`;
  // Look for any surviving fragment of the value at the truncation boundary.
  const frags = [];
  for (let n = 4; n <= SENTINEL.length; n++) {
    const p = SENTINEL.slice(0, n);
    if (out.includes(p)) frags.push(n);
  }
  console.log(`    longest raw prefix of the value surviving truncation: ${frags.length ? Math.max(...frags) : 0} chars`);
}

console.log('=== error branches ===');
cli('unknown command', ['nope']);
cli('revoke with no KEY', ['revoke']);
cli('set with no interactive surface', ['set', 'OPENAI_API_KEY', '--json']);
cli('ensure (CI, no surface)', ['ensure', '--json']);
cli('run against a missing binary', ['run', '--yes', '--json', '--', 'definitely-not-a-real-binary-xyz'], {
  ENVSEAL_ASSUME_YES: '1',
});
cli('status on an unreadable manifest', ['status', '--json'], { ENVSEAL_BREAK: '1' });
// Corrupt the manifest and re-run.
const manifestPath = join(root, 'env.schema.jsonc');
const goodManifest = readFileSync(manifestPath, 'utf8');
writeFileSync(manifestPath, '{ this is not json', 'utf8');
cli('status with a corrupt manifest', ['status', '--json']);
cli('doctor with a corrupt manifest', ['doctor', '--json']);
writeFileSync(manifestPath, goodManifest, 'utf8');
// Read-only .env, then revoke (sink write failure).
chmodSync(join(root, '.env'), 0o444);
cli('revoke against a read-only .env', ['revoke', 'OPENAI_API_KEY', '--json']);
chmodSync(join(root, '.env'), 0o644);

console.log('=== sweep ===');
let leaks = 0;
for (const t of transcript) {
  const i = t.combined.indexOf(SENTINEL);
  if (i >= 0) {
    leaks++;
    console.log(`  LEAK in: ${t.label}  (argv: ${JSON.stringify(t.args)})`);
    console.log(`    context: ${JSON.stringify(t.combined.slice(Math.max(0, i - 260), i + 90))}`);
  }
}
const allOutput = transcript.map((t) => t.combined).join('\n');
console.log(`  commands run: ${transcript.length}, combined stdout+stderr bytes: ${allOutput.length}`);
console.log(`  sentinel leaks: ${leaks}`);
console.log(`  7-byte value appears in output: ${allOutput.includes(`short=${SHORT}`)}  (redactor floor is 8 bytes)`);
console.log(`  hex encoding survives: ${allOutput.includes(Buffer.from(SENTINEL).toString('hex'))}`);
const half1 = SENTINEL.slice(0, 12);
const half2 = SENTINEL.slice(12);
console.log(`  newline-split halves both present: ${allOutput.includes(half1) && allOutput.includes(half2)}`);

console.log('  --- on-disk artifacts ---');
for (const [label, p] of [
  ['.env (intended sink)', join(root, '.env')],
  ['env.schema.jsonc', manifestPath],
  ['.envseal/audit.jsonl', join(root, '.envseal', 'audit.jsonl')],
  ['.envseal/approvals.json', join(root, '.envseal', 'approvals.json')],
  ['.envseal/salt', join(root, '.envseal', 'salt')],
]) {
  if (!existsSync(p)) {
    console.log(`  ${label.padEnd(26)} (absent)`);
    continue;
  }
  console.log(`  ${label.padEnd(26)} sentinel=${readFileSync(p, 'utf8').includes(SENTINEL)}`);
}

rmSync(root, { recursive: true, force: true });
