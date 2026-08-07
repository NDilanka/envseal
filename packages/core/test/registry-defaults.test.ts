import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../src/broker.js';
import { secretFromUtf8 } from '@envseal/protocol';
import type { Prompter } from '@envseal/prompters';

/**
 * Registry enrichment on the model-facing paths.
 *
 * A model declaring `OPENAI_API_KEY` should not have to know the key's format,
 * signup URL, or verification endpoint — that is what the bundled registry is
 * for. Both of these were silently broken: `declare` looked the key up with
 * `getProvider(envVar)` when provider ids are 'openai'/'stripe'/…, and `revoke`
 * only read the manifest, so a key declared with just `provider.id` reported no
 * rotation URL. Neither failure surfaced as an error; the metadata was simply
 * absent, which costs format validation, the "get your key" link in the prompt,
 * the verify probe, and the rotation guidance after a leak.
 */

const noopPrompter: Prompter = {
  id: 'none',
  available: async () => true,
  prompt: async (req) => ({
    ticket: req.ticket,
    results: req.keys.map((k) => ({
      key: k.key,
      outcome: 'entered' as const,
      value: secretFromUtf8('sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'),
    })),
  }),
  cancel: async () => {},
};

describe('registry defaults', () => {
  let root: string;
  let broker: Broker;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'envseal-regdefaults-'));
    writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
    broker = new Broker({ root, prompter: noopPrompter });
  });

  afterEach(() => {
    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  function readEntry(key: string): Record<string, unknown> {
    const text = readFileSync(join(root, 'env.schema.jsonc'), 'utf8');
    const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
      entries: Array<Record<string, unknown>>;
    };
    const entry = parsed.entries.find((e) => e.key === key);
    expect(entry, `${key} not found in manifest`).toBeDefined();
    return entry as Record<string, unknown>;
  }

  it('declare fills format, provider and verify for a known env var', async () => {
    await broker.declare({
      entries: [
        { key: 'OPENAI_API_KEY', description: 'used by the client', required: true, secret: true },
      ],
    });

    const entry = readEntry('OPENAI_API_KEY');
    expect(entry.format, 'format not filled from registry').toBeDefined();
    expect(entry.provider, 'provider not filled from registry').toMatchObject({ id: 'openai' });
    expect(entry.verify, 'verify probe not filled from registry').toMatchObject({
      url: 'https://api.openai.com/v1/models',
    });
  });

  it('declare leaves an unknown env var untouched', async () => {
    await broker.declare({
      entries: [
        { key: 'SOME_INTERNAL_THING', description: 'bespoke', required: true, secret: true },
      ],
    });
    const entry = readEntry('SOME_INTERNAL_THING');
    expect(entry.provider).toBeUndefined();
    expect(entry.verify).toBeUndefined();
  });

  it('declare does not overwrite caller-supplied metadata', async () => {
    await broker.declare({
      entries: [
        {
          key: 'OPENAI_API_KEY',
          description: 'custom',
          required: true,
          secret: true,
          format: { pattern: '^custom-.+$', example: 'custom-XXXX' },
        },
      ],
    });
    const entry = readEntry('OPENAI_API_KEY');
    expect(entry.format).toMatchObject({ pattern: '^custom-.+$' });
  });

  it('revoke reports the rotation URL from the registry when the manifest omits it', async () => {
    await broker.declare({
      entries: [
        {
          key: 'OPENAI_API_KEY',
          description: 'used by the client',
          required: true,
          secret: true,
          // Only the id — exactly what a model typically supplies.
          provider: { id: 'openai', name: 'OpenAI' },
        },
      ],
    });

    const ticket = await broker.request({ keys: ['OPENAI_API_KEY'], reason: 'test' });
    await broker.await({ ticket: ticket.ticket, timeoutMs: 10_000 });

    const results = await broker.revoke({ keys: ['OPENAI_API_KEY'] });
    expect(results[0]?.removed).toBe(true);
    expect(
      results[0]?.rotateUrl,
      'revoke must tell the user where to invalidate the old key',
    ).toBe('https://platform.openai.com/account/api-keys');
  });
});
