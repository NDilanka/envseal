// Launch blocker B2 — PLAN §2.2 threat T3, clause 2.
//
// "Any request whose free-text fields match the secret-shaped detector is
// rejected, logged, and surfaced to the user."
//
// Runs the reported reproduction against the BUILT artifact (packages/core/dist),
// in a throwaway temp root, and reports whether the sentinel reached
// env.schema.jsonc (committed to git, §6.1) or .envseal/audit.jsonl (names only,
// §4.1). Exits non-zero on a leak, and also on a false positive — a guard that
// refuses everything is not a fix.
//
//   pnpm -r build && node scripts/probe-b2-detector.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/core/dist/index.js';

// Structurally realistic, deliberately fake: the body carries the marker FAKE.
const SECRET = 'sk-proj-FAKE7Qm2Xp9Lz4Rv8Nc3Bd6Hk1Ws5Yt0Ju7Gi2Ae4Of6Pl9Zx3Cn8Mb';

const stubPrompter = {
  id: 'loopback-browser',
  available: async () => true,
  prompt: async (req) => ({
    ticket: req.ticket,
    results: req.keys.map((k) => ({ key: k.key, outcome: 'cancelled' })),
  }),
  cancel: async () => {},
};

function freshRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `envseal-b2-${tag}-`));
  writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
  return root;
}

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function attempt(label, run) {
  try {
    await run();
    return { label, outcome: 'ACCEPTED', code: null, message: null };
  } catch (error) {
    return {
      label,
      outcome: 'REJECTED',
      code: error?.code ?? null,
      message: error?.userMessage ?? String(error),
    };
  }
}

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  !! ${msg}`);
};

// ---------------------------------------------------------------- reproduction
console.log('=== reproduction: secret-shaped text in env_declare and env_request ===');
{
  const root = freshRoot('repro');
  const manifestPath = join(root, 'env.schema.jsonc');
  const auditPath = join(root, '.envseal', 'audit.jsonl');
  const broker = new Broker({ root, prompter: stubPrompter });

  const declared = await attempt('env_declare', () =>
    broker.declare({
      entries: [
        {
          key: 'OPENAI_API_KEY',
          description: `use ${SECRET}`,
          format: { pattern: '^sk-.+$', example: SECRET },
          required: true,
          secret: true,
        },
      ],
    }),
  );
  console.log(`  env_declare : ${declared.outcome}${declared.code ? ` (${declared.code})` : ''}`);
  if (declared.message) console.log(`                ${declared.message}`);

  // The request needs a declared key to get past SEP_NOT_DECLARED. Use a
  // SEPARATE key for that: re-declaring OPENAI_API_KEY cleanly would overwrite
  // the leaky entry above and hide the manifest leak this probe exists to find.
  await attempt('setup', () =>
    broker.declare({ entries: [{ key: 'CLEAN_KEY', description: 'An ordinary key' }] }),
  );

  const requested = await attempt('env_request', () =>
    broker.request({ keys: ['CLEAN_KEY'], reason: `the key is ${SECRET}` }),
  );
  console.log(`  env_request : ${requested.outcome}${requested.code ? ` (${requested.code})` : ''}`);
  if (requested.message) console.log(`                ${requested.message}`);

  broker.dispose();

  const manifestText = readIfPresent(manifestPath);
  const auditText = readIfPresent(auditPath);
  const inManifest = manifestText.includes(SECRET);
  const inAudit = auditText.includes(SECRET);

  console.log(`  env.schema.jsonc      : ${inManifest ? 'LEAK' : 'clean'}`);
  console.log(`  .envseal/audit.jsonl  : ${inAudit ? 'LEAK' : 'clean'}`);

  if (inManifest) fail('sentinel reached env.schema.jsonc');
  if (inAudit) fail('sentinel reached .envseal/audit.jsonl');
  if (declared.outcome !== 'REJECTED') fail('env_declare accepted a credential-bearing entry');
  if (requested.outcome !== 'REJECTED') fail('env_request accepted a credential-bearing reason');
  if (declared.outcome === 'REJECTED' && declared.code !== 'SEP_VALUE_IN_REQUEST') {
    fail(`env_declare rejected with ${declared.code}, expected SEP_VALUE_IN_REQUEST`);
  }
  if (requested.outcome === 'REJECTED' && requested.code !== 'SEP_VALUE_IN_REQUEST') {
    fail(`env_request rejected with ${requested.code}, expected SEP_VALUE_IN_REQUEST`);
  }
  if (declared.message?.includes(SECRET) || requested.message?.includes(SECRET)) {
    fail('the rejection message quoted the matched text');
  }

  // The rejection must still be logged (T3 says rejected, LOGGED, surfaced).
  const blocked = auditText
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === 'blocked');
  console.log(`  blocked audit records : ${blocked.length} (${blocked.map((b) => b.reason).join(', ')})`);
  if (blocked.length !== 2) fail(`expected 2 blocked audit records, saw ${blocked.length}`);

  rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------- false-positive control
console.log('\n=== control: ordinary metadata must still be declarable ===');
{
  const root = freshRoot('control');
  const manifestPath = join(root, 'env.schema.jsonc');
  const broker = new Broker({ root, prompter: stubPrompter });

  const cases = [
    {
      key: 'OPENAI_API_KEY',
      description: 'Your OpenAI key, starts with sk-',
      format: { pattern: '^sk-[A-Za-z0-9]{20,}$', example: 'sk-XXXXXXXXXXXXXXXXXXXX' },
    },
    {
      key: 'DATABASE_URL',
      description: 'Postgres connection string, e.g. postgresql://USERNAME:PASSWORD@localhost:5432/mydb',
    },
    {
      key: 'STRIPE_WEBHOOK_SIGNING_SECRET_V2',
      description: 'Verifies webhook payload signatures',
    },
  ];

  for (const entry of cases) {
    const result = await attempt(entry.key, () => broker.declare({ entries: [entry] }));
    console.log(`  declare ${entry.key.padEnd(32)}: ${result.outcome}`);
    if (result.outcome !== 'ACCEPTED') {
      fail(`${entry.key} was rejected: ${result.message}`);
    }
  }

  const reason = await attempt('reason', () =>
    broker.request({
      keys: ['OPENAI_API_KEY'],
      reason: 'Need the key to call the completions endpoint from the test suite',
    }),
  );
  console.log(`  request with an ordinary reason  : ${reason.outcome}`);
  if (reason.outcome !== 'ACCEPTED') fail(`an ordinary reason was rejected: ${reason.message}`);

  broker.dispose();

  const manifestText = readIfPresent(manifestPath);
  for (const entry of cases) {
    if (!manifestText.includes(entry.key)) fail(`${entry.key} never reached the manifest`);
  }

  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== ${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`} ===`);
process.exit(failures === 0 ? 0 : 1);
