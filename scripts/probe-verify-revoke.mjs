// Manual probe: exercise env_verify (real network call to a provider) and
// env_revoke, neither of which the automated suites cover end to end.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../packages/core/dist/index.js';
import { secretFromUtf8 } from '../packages/protocol/dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'envseal-probe-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');

const stub = {
  id: 'ide',
  available: async () => true,
  prompt: async (req) => ({
    ticket: req.ticket,
    results: req.keys.map((k) => ({
      key: k.key,
      outcome: 'entered',
      value: secretFromUtf8('sk-DEADBEEF00000000000000000000000000000000000000000'),
    })),
  }),
  cancel: async () => {},
};

const broker = new Broker({ root, prompter: stub });

await broker.declare({
  entries: [
    {
      key: 'OPENAI_API_KEY',
      description: 'probe',
      required: true,
      secret: true,
      provider: { id: 'openai', name: 'OpenAI' },
      verify: {
        method: 'GET',
        url: 'https://api.openai.com/v1/models',
        headerTemplate: { Authorization: 'Bearer {{value}}' },
        expectStatus: [200],
      },
    },
  ],
});

const ticket = await broker.request({ keys: ['OPENAI_API_KEY'], reason: 'probe' });
await broker.await({ ticket: ticket.ticket, timeoutMs: 10000 });

console.log('--- env_verify against the real provider (key is deliberately invalid) ---');
const results = await broker.verify({ keys: ['OPENAI_API_KEY'] });
for (const r of results) {
  console.log(`  ${r.key}: result=${r.result} message=${JSON.stringify(r.message)}`);
  // The message must never carry the value or the upstream response body.
  if (r.message.includes('DEADBEEF')) console.log('  !! LEAK: value appeared in verify message');
}

console.log('--- env_revoke ---');
const revoked = await broker.revoke({ keys: ['OPENAI_API_KEY'] });
console.log('  ', JSON.stringify(revoked));

const after = await broker.describe();
const entry = after.entries.find((e) => e.key === 'OPENAI_API_KEY');
console.log(`  present after revoke: ${entry?.present}`);

broker.dispose();
rmSync(root, { recursive: true, force: true });
