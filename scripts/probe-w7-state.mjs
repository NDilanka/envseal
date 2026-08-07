// W7 — corrupt broker state and corrupt manifests.
//
// Every one of these inputs is something a user, a merge conflict, or a full
// disk can produce. The question in each case is not "does it crash" but "does
// it fail loudly". Silently treating a corrupt manifest as an empty one is the
// worst outcome available, because the next write persists that emptiness.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker, projectPaths, loadOrCreateSalt } from '../packages/core/dist/index.js';

const roots = [];
function newRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `envseal-w7-${name}-`));
  roots.push(root);
  writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
  return root;
}

const stubPrompter = {
  id: 'none',
  available: async () => true,
  prompt: async () => ({ ticket: '', results: [] }),
  cancel: async () => {},
};

function withBroker(root, fn) {
  const broker = new Broker({ root, prompter: stubPrompter });
  try {
    return fn(broker);
  } finally {
    broker.dispose();
  }
}

async function tryCall(label, fn) {
  try {
    const value = await fn();
    return { threw: false, value };
  } catch (err) {
    return { threw: true, code: err.code ?? null, name: err.name, message: String(err.message).slice(0, 200) };
  }
}

function show(r) {
  return r.threw ? `THREW ${r.code ?? r.name}: ${r.message}` : `OK ${JSON.stringify(r.value)}`;
}

console.log('=== W7 corrupt state ===\n');

// --- .envseal/ state -----------------------------------------------------

// 1. .envseal missing entirely
{
  const root = newRoot('nostate');
  const r = await tryCall('describe', async () => withBroker(root, (b) => b.describe()).then((s) => ({ entries: s.entries.length })));
  console.log('1. .envseal/ missing');
  console.log('   expected : created on demand');
  console.log(`   observed : ${show(r)}; .envseal/salt exists=${existsSync(join(root, '.envseal', 'salt'))}`);
  console.log();
}

// 2/3. salt truncated to 0 and to 3 bytes
for (const size of [0, 3]) {
  const root = newRoot(`salt${size}`);
  const paths = projectPaths(root);
  const original = loadOrCreateSalt(paths);
  const originalHex = original.toString('hex');
  truncateSync(paths.salt, size);
  const after = loadOrCreateSalt(paths);
  console.log(`${size === 0 ? 2 : 3}. .envseal/salt truncated to ${size} bytes`);
  console.log('   expected : loud failure, or a documented regeneration — NOT a silent swap');
  console.log(`   observed : no error; salt length now ${after.length}; regenerated=${after.toString('hex') !== originalHex}`);
  console.log('   consequence: every previously recorded fingerprint fp_* silently changes meaning');
  console.log();
}

// 4. approvals.json is corrupt JSON
{
  const root = newRoot('approvals');
  const paths = projectPaths(root);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.approvals, '{"broken": ', 'utf8');
  const entry = {
    key: 'W7_KEY',
    description: 'w7',
    required: true,
    secret: true,
    verify: { method: 'GET', url: 'https://api.openai.com/v1/models', headerTemplate: { Authorization: 'Bearer {{value}}' }, successStatus: [200] },
  };
  const r = await tryCall('verify', async () =>
    withBroker(root, async (b) => {
      await b.declare({ entries: [entry] });
      writeFileSync(paths.dotenv, 'W7_KEY=sk-fake\n', 'utf8');
      const res = await b.verify({ keys: ['W7_KEY'] });
      return res.map((x) => ({ key: x.key, result: x.result, message: x.message }));
    }),
  );
  console.log('4. .envseal/approvals.json is corrupt JSON');
  console.log('   expected : fail closed — treat as "nothing approved", never as "all approved"');
  console.log(`   observed : ${show(r)}`);
  console.log();
}

// --- env.schema.jsonc --------------------------------------------------

const GOOD_ENTRY = '{"key":"W7_KEY","description":"declared earlier by the user","required":true,"secret":true}';

const manifestCases = [
  [
    '5. manifest truncated mid-object',
    `{\n  "version": 1,\n  "entries": [\n    ${GOOD_ENTRY},\n    {"key": "W7_OTHER", "descrip`,
  ],
  [
    '6. manifest with an unknown TOP-LEVEL field',
    `{\n  "version": 1,\n  "entries": [${GOOD_ENTRY}],\n  "unknownTopLevel": true\n}\n`,
  ],
  [
    '7. manifest entry with an unknown field (must be rejected by .strict())',
    `{\n  "version": 1,\n  "entries": [{"key":"W7_KEY","description":"d","required":true,"secret":true,"value":"leaked-secret-here"}]\n}\n`,
  ],
  ['8. manifest with "version": 2', `{\n  "version": 2,\n  "entries": [${GOOD_ENTRY}]\n}\n`],
];

for (const [label, text] of manifestCases) {
  const root = newRoot('manifest');
  const paths = projectPaths(root);
  writeFileSync(paths.manifest, text, 'utf8');

  const described = await tryCall('describe', async () =>
    withBroker(root, async (b) => {
      const s = await b.describe();
      return { entries: s.entries.map((e) => e.key), missingRequired: s.missingRequired };
    }),
  );
  const requested = await tryCall('request', async () =>
    withBroker(root, async (b) => {
      const t = await b.request({ keys: ['W7_KEY'], reason: 'w7' });
      return { surface: t.surface };
    }),
  );

  const beforeBytes = readFileSync(paths.manifest, 'utf8');
  const declared = await tryCall('declare', async () =>
    withBroker(root, (b) => b.declare({ entries: [{ key: 'W7_NEW', description: 'added later', required: true, secret: true }] })),
  );
  const afterBytes = readFileSync(paths.manifest, 'utf8');
  const stillMentionsOriginal = afterBytes.includes('W7_KEY');

  console.log(label);
  console.log('   expected : loud rejection (SEP_FORMAT_INVALID or similar); the file is NEVER silently treated as empty and NEVER overwritten');
  console.log(`   describe : ${show(described)}`);
  console.log(`   request  : ${show(requested)}`);
  console.log(`   declare  : ${show(declared)}`);
  console.log(`   manifest rewritten by declare: ${beforeBytes !== afterBytes}`);
  console.log(`   original W7_KEY declaration survived: ${stillMentionsOriginal}`);
  if (!described.threw && described.value.entries.length === 0) {
    console.log('   !! corrupt manifest silently reported as EMPTY  <-- HIGH');
  }
  if (beforeBytes !== afterBytes && !stillMentionsOriginal) {
    console.log('   !! declare OVERWROTE the manifest and DROPPED prior declarations  <-- HIGH (data loss)');
  }
  console.log();
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
