import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ProviderSchema } from '../src/schema.js';

describe('Provider files', () => {
  const providersDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers');
  const files = readdirSync(providersDir, { withFileTypes: false })
    .filter((file) => file.endsWith('.json'))
    .sort();

  it('should have at least 30 providers', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it('every file should parse against the schema', () => {
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`${file}: ${result.error.message}`);
      }
    }
  });

  it('id field should equal filename stem', () => {
    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        const stem = file.replace(/\.json$/, '');
        expect(result.data.id).toBe(stem);
      }
    }
  });

  it('should have no duplicate envVar across all providers', () => {
    const envVars = new Set<string>();
    const duplicates: string[] = [];

    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);
      expect(result.success).toBe(true);

      if (result.success) {
        for (const key of result.data.keys) {
          if (envVars.has(key.envVar)) {
            duplicates.push(key.envVar);
          }
          envVars.add(key.envVar);
        }
      }
    }

    if (duplicates.length > 0) {
      throw new Error(`Duplicate envVars found: ${duplicates.join(', ')}`);
    }
    expect(duplicates).toHaveLength(0);
  });
});
