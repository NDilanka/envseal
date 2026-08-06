import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ProviderSchema } from '../src/schema.js';

describe('Provider safety checks', () => {
  const providersDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers');
  const files = readdirSync(providersDir, { withFileTypes: false })
    .filter((file) => file.endsWith('.json'))
    .sort();

  it('every verify.url should start with https://', () => {
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);

      if (result.success) {
        for (const key of result.data.keys) {
          if (key.verify?.url !== undefined) {
            expect(key.verify.url).toMatch(/^https:\/\//);
          }
        }
      }
    }
  });

  it('no verify.url should contain {{value}}', () => {
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);

      if (result.success) {
        for (const key of result.data.keys) {
          if (key.verify?.url !== undefined) {
            expect(key.verify.url).not.toContain('{{value}}');
          }
        }
      }
    }
  });

  it('every verify.headerTemplate should have at least one value containing {{value}}', () => {
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);

      if (result.success) {
        for (const key of result.data.keys) {
          if (key.verify?.headerTemplate !== undefined) {
            const hasValue = Object.values(key.verify.headerTemplate).some((v) =>
              String(v).includes('{{value}}')
            );
            expect(hasValue).toBe(true);
          }
        }
      }
    }
  });
});
