// Reproduction probe for launch blocker B4: `envseal verify` aborts with a libuv
// assertion instead of exiting 6.
//
// Builds a throwaway project OUTSIDE this repo (mkdtemp under the OS temp dir —
// never process.cwd(), which would make the CLI operate on the envseal source
// tree), gives it a key whose probe hits an allowlisted host that answers 401,
// and runs the real dist/bin.js N times recording the exit code and stderr.
//
// Usage: node scripts/probe-b4-repro.mjs [runs]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const runs = Number(process.argv[2] ?? 5);

const root = mkdtempSync(join(tmpdir(), 'envseal-b4-repro-'));
writeFileSync(
  join(root, 'env.schema.jsonc'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        {
          key: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
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
      ],
    },
    null,
    2,
  ),
);
writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-not-a-real-key-b4-probe\n');

console.log(`project root: ${root}`);
console.log(`bin:          ${bin}`);

let bad = 0;
for (let i = 1; i <= runs; i++) {
  const r = spawnSync('node', [bin, 'verify', '--project', root, '--json'], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  const stderr = (r.stderr ?? '').trim();
  const assertion = /Assertion failed|uv_|libuv/i.test(stderr);
  const ok = r.status === 6 && !assertion;
  if (!ok) bad++;
  console.log(
    `run ${i}: exit=${r.status} signal=${r.signal ?? '-'} assertion=${assertion ? 'YES' : 'no'} ${ok ? 'PASS' : 'FAIL'}`,
  );
  console.log(`  stdout: ${(r.stdout ?? '').trim()}`);
  if (stderr) console.log(`  stderr: ${stderr}`);
}

rmSync(root, { recursive: true, force: true });
console.log(bad === 0 ? `ALL ${runs} RUNS EXITED 6 WITH NO LIBUV ASSERTION` : `${bad}/${runs} RUNS BAD`);
process.exit(bad === 0 ? 0 : 1);
