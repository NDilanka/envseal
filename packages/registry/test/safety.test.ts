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
});
