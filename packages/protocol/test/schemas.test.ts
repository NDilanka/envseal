import { describe, it, expect } from 'vitest';
import {
  Manifest,
  ManifestEntry,
  EnvRequestInput,
  EnvAwaitInput,
} from '../src/schemas.js';

describe('ManifestEntry', () => {
  it('rejects unknown fields even when the object looks like a key', () => {
    const result = ManifestEntry.safeParse({ key: 'X', description: 'd', value: 'sk-1' });
    expect(result.success).toBe(false);
  });

  it('rejects an injected value-shaped secret field (T3)', () => {
    const result = ManifestEntry.safeParse({ key: 'OPENAI_API_KEY', description: 'd', value: 'sk-real-key' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid minimal entry and applies defaults', () => {
    const result = ManifestEntry.safeParse({ key: 'OPENAI_API_KEY', description: 'used by llm client' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.required).toBe(true);
      expect(result.data.secret).toBe(true);
      expect(result.data.sink).toBe('dotenv');
      expect(result.data.verify).toBeUndefined();
    }
  });

  it('accepts a fully-populated entry', () => {
    const entry = {
      key: 'OPENAI_API_KEY',
      description: 'Used by src/llm/client.ts.',
      required: true,
      secret: true,
      format: { pattern: '^sk-[A-Za-z0-9_-]{20,}$', example: 'sk-XXXXXXXXXXXXXXXXXXXX' },
      provider: {
        id: 'openai',
        name: 'OpenAI',
        signupUrl: 'https://platform.openai.com/api-keys',
      },
      verify: {
        method: 'GET',
        url: 'https://api.openai.com/v1/models',
        headerTemplate: { Authorization: 'Bearer {{value}}' },
        expectStatus: [200, 401],
      },
      sink: 'dotenv',
      rotation: { maxAgeDays: 90 },
    };
    expect(ManifestEntry.safeParse(entry).success).toBe(true);
  });

  describe('key validation', () => {
    it('accepts a 64-char uppercase key', () => {
      const key = `K${'_'.repeat(63)}`;
      expect(ManifestEntry.safeParse({ key, description: 'd' }).success).toBe(true);
    });

    const invalidKeys = [
      'openai_api_key',
      'OPENAI-API-KEY',
      '1OPENAI',
      'OPENAI API KEY',
      `${'K'.repeat(64)}_`,
    ];
    for (const key of invalidKeys) {
      it(`rejects key ${JSON.stringify(key)}`, () => {
        expect(ManifestEntry.safeParse({ key, description: 'd' }).success).toBe(false);
      });
    }
  });

  describe('description length', () => {
    it('rejects a 281-char description', () => {
      expect(ManifestEntry.safeParse({ key: 'K', description: 'd'.repeat(281) }).success).toBe(false);
    });

    it('accepts a 280-char description', () => {
      expect(ManifestEntry.safeParse({ key: 'K', description: 'd'.repeat(280) }).success).toBe(true);
    });
  });

  describe('verify.url validation', () => {
    it('requires https', () => {
      const entry = { key: 'K', description: 'd', verify: { method: 'GET', url: 'http://api.example.com/x', headerTemplate: {} } };
      expect(ManifestEntry.safeParse(entry).success).toBe(false);
    });

    it('rejects a url containing {{value}}', () => {
      const entry = { key: 'K', description: 'd', verify: { method: 'GET', url: 'https://api.example.com/fetch?token={{value}}', headerTemplate: {} } };
      expect(ManifestEntry.safeParse(entry).success).toBe(false);
    });

    it('accepts an https url without {{value}}', () => {
      const entry = { key: 'K', description: 'd', verify: { method: 'GET', url: 'https://api.example.com/v1/models', headerTemplate: {} } };
      expect(ManifestEntry.safeParse(entry).success).toBe(true);
    });

    it('rejects a bare https url that is not a valid url', () => {
      const entry = { key: 'K', description: 'd', verify: { method: 'GET', url: 'https://', headerTemplate: {} } };
      expect(ManifestEntry.safeParse(entry).success).toBe(false);
    });

    it('still rejects unknown fields on a full entry', () => {
      const entry = { key: 'K', description: 'd', value: 'v', verify: { method: 'GET', url: 'https://api.example.com/x', headerTemplate: {} } };
      expect(ManifestEntry.safeParse(entry).success).toBe(false);
    });
  });
});

describe('Manifest', () => {
  it('requires version 1 and strict shape', () => {
    const manifest = {
      $schema: 'https://envseal.dev/spec/sep-1/manifest.schema.json',
      version: 1,
      entries: [{ key: 'OPENAI_API_KEY', description: 'd' }],
    };
    const ok = Manifest.safeParse(manifest);
    expect(ok.success).toBe(true);

    expect(Manifest.safeParse({ ...manifest, version: 2 }).success).toBe(false);
    expect(Manifest.safeParse({ ...manifest, extra: true }).success).toBe(false);
  });
});

describe('EnvRequestInput', () => {
  it('rejects an empty reason', () => {
    expect(EnvRequestInput.safeParse({ keys: ['OPENAI_API_KEY'], reason: '' }).success).toBe(false);
  });

  it('rejects a reason longer than 280 chars', () => {
    expect(EnvRequestInput.safeParse({ keys: ['K'], reason: 'r'.repeat(281) }).success).toBe(false);
  });

  it('accepts a 1-char and a 280-char reason', () => {
    expect(EnvRequestInput.safeParse({ keys: ['K'], reason: 'r' }).success).toBe(true);
    expect(EnvRequestInput.safeParse({ keys: ['K'], reason: 'r'.repeat(280) }).success).toBe(true);
  });

  it('rejects an empty keys array and unknown fields', () => {
    expect(EnvRequestInput.safeParse({ keys: [], reason: 'r' }).success).toBe(false);
    expect(EnvRequestInput.safeParse({ keys: ['K'], reason: 'r', value: 'v' }).success).toBe(false);
  });
});

describe('EnvAwaitInput', () => {
  it('defaults timeoutMs to 90000', () => {
    const result = EnvAwaitInput.safeParse({ ticket: 'tkt_1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeoutMs).toBe(90000);
    }
  });

  it('bounds timeoutMs to [1000, 120000]', () => {
    expect(EnvAwaitInput.safeParse({ ticket: 't', timeoutMs: 900 }).success).toBe(false);
    expect(EnvAwaitInput.safeParse({ ticket: 't', timeoutMs: 999 }).success).toBe(false);
    expect(EnvAwaitInput.safeParse({ ticket: 't', timeoutMs: 1000 }).success).toBe(true);
    expect(EnvAwaitInput.safeParse({ ticket: 't', timeoutMs: 120000 }).success).toBe(true);
    expect(EnvAwaitInput.safeParse({ ticket: 't', timeoutMs: 120001 }).success).toBe(false);
  });
});
