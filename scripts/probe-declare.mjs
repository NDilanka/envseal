// Does env_declare fill in registry defaults for a well-known key name?
// This is the path a model uses: it declares OPENAI_API_KEY and should get the
// format pattern, provider links, and verify probe for free.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/core/dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'envseal-declare-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');

const broker = new Broker({ root, prompter: { id: 'ide', available: async () => true, prompt: async () => ({ ticket: '', results: [] }), cancel: async () => {} } });

await broker.declare({
  entries: [{ key: 'OPENAI_API_KEY', description: 'used by the client', required: true, secret: true }],
});

const text = readFileSync(join(root, 'env.schema.jsonc'), 'utf8');
const entry = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')).entries[0];
console.log('format  :', entry.format ? 'FILLED' : 'MISSING');
console.log('provider:', entry.provider ? `FILLED (${entry.provider.id})` : 'MISSING');
console.log('verify  :', entry.verify ? `FILLED (${entry.verify.url})` : 'MISSING');

broker.dispose();
rmSync(root, { recursive: true, force: true });
