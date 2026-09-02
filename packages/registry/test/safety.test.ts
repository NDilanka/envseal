import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ProviderSchema, ProviderKeySchema } from '../src/schema.js';

const FORMAT_PATTERN_MAX_LENGTH = 256;

/** Reject manifest-unsafe `{m,}` quantifiers (no upper bound). */
function hasUnboundedBraceQuantifier(pattern: string): boolean {
  return /\{\d+,\s*\}/.test(pattern);
}

function isBoundedPattern(pattern: string): boolean {
  if (pattern.length > FORMAT_PATTERN_MAX_LENGTH) {
    return false;
  }
  if (hasUnboundedBraceQuantifier(pattern)) {
    return false;
  }
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function minimalProviderKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envVar: 'TEST_API_KEY',
    description: 'Test key',
    format: {
      example: 'sk-XXXXXXXXXXXXXXXXXXXX',
    },
    ...overrides,
  };
}

describe('Provider safety checks', () => {
  const providersDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers');
  const files = readdirSync(providersDir, { withFileTypes: false })
    .filter((file) => file.endsWith('.json'))
    .sort();

  // Guards the whole file: every assertion below sits inside a per-provider
  // loop, so a schema change that stopped these files parsing would skip every
  // body and leave three green tests asserting nothing at all.
  it('every provider file parses', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const data = JSON.parse(readFileSync(join(providersDir, file), 'utf-8')) as unknown;
      const result = ProviderSchema.safeParse(data);
      expect(result.success, `${file} failed to parse`).toBe(true);
    }
  });

  it('every verify.url should start with https://', () => {
    let checked = 0;
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);
      expect(result.success, `${file} failed to parse`).toBe(true);

      if (result.success) {
        for (const key of result.data.keys) {
          if (key.verify?.url !== undefined) {
            checked += 1;
            expect(key.verify.url).toMatch(/^https:\/\//);
          }
        }
      }
    }
    // Without this the test passes when no provider declares a verify block.
    expect(checked, 'no verify.url was actually checked').toBeGreaterThan(0);
  });

  it('no verify.url should contain {{value}}', () => {
    let checked = 0;
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);
      expect(result.success, `${file} failed to parse`).toBe(true);

      if (result.success) {
        for (const key of result.data.keys) {
          if (key.verify?.url !== undefined) {
            checked += 1;
            expect(key.verify.url).not.toContain('{{value}}');
          }
        }
      }
    }
    expect(checked, 'no verify.url was actually checked').toBeGreaterThan(0);
  });

  it('every verify.headerTemplate should have at least one value containing {{value}}', () => {
    let checked = 0;
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);
      expect(result.success, `${file} failed to parse`).toBe(true);

      if (result.success) {
        for (const key of result.data.keys) {
          if (key.verify?.headerTemplate !== undefined) {
            checked += 1;
            const hasValue = Object.values(key.verify.headerTemplate).some((v) =>
              String(v).includes('{{value}}')
            );
            expect(hasValue).toBe(true);
          }
        }
      }
    }
    expect(checked, 'no verify.headerTemplate was actually checked').toBeGreaterThan(0);
  });

  it('every format.pattern is a bounded, safe regex', () => {
    let checked = 0;
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);
      expect(result.success, `${file} failed to parse`).toBe(true);

      if (result.success) {
        for (const key of result.data.keys) {
          const pattern = key.format.pattern;
          if (pattern === undefined) {
            continue;
          }
          checked += 1;
          expect(
            isBoundedPattern(pattern),
            `${file} ${key.envVar}: pattern "${pattern}" is unbounded or invalid`
          ).toBe(true);
        }
      }
    }
    expect(checked, 'no format.pattern was actually checked').toBeGreaterThan(0);
  });
});

describe('ProviderKeySchema verify.url', () => {
  it('rejects http:// verify.url at parse time', () => {
    const result = ProviderKeySchema.safeParse(
      minimalProviderKey({
        verify: {
          method: 'GET',
          url: 'http://api.example.com/v1/models',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
        },
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'verify.url')).toBe(true);
    }
  });

  it('accepts https:// verify.url', () => {
    const result = ProviderKeySchema.safeParse(
      minimalProviderKey({
        verify: {
          method: 'GET',
          url: 'https://api.example.com/v1/models',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
        },
      })
    );
    expect(result.success).toBe(true);
  });
});
