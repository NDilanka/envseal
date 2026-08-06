import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ProviderSchema } from '../src/schema.js';

describe('Provider examples', () => {
  const providersDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'providers');
  const files = readdirSync(providersDir, {
    encoding: 'utf-8',
  }).filter((f) => f.endsWith('.json')).sort();

  it('example should match pattern if present', () => {
    const failures: string[] = [];

    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);

      if (result.success) {
        for (const key of result.data.keys) {
          if (key.format.pattern !== undefined) {
            const regex = new RegExp(key.format.pattern);
            if (!regex.test(key.format.example)) {
              failures.push(
                `${file}: example "${key.format.example}" does not match pattern "${key.format.pattern}"`
              );
            }
          }
        }
      }
    }

    if (failures.length > 0) {
      console.log('\n' + failures.join('\n'));
    }
    expect(failures).toHaveLength(0);
  });

  it('example should be obviously fake (only X/x/0/1/._- after prefix)', () => {
    const failures: string[] = [];

    for (const file of files) {
      const filePath = join(providersDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const result = ProviderSchema.safeParse(data);

      if (result.success) {
        for (const key of result.data.keys) {
          let remainder = key.format.example;

          // Strip prefix if present
          if (key.format.prefix !== undefined) {
            if (remainder.startsWith(key.format.prefix)) {
              remainder = remainder.slice(key.format.prefix.length);
            }
          }

          // Check if remainder consists only of X, x, 0, 1, -, _, .
          const isFake = /^[Xx01._-]+$/.test(remainder);
          if (!isFake) {
            failures.push(
              `${file}: example "${key.format.example}" (remainder "${remainder}") does not look obviously fake`
            );
          }
        }
      }
    }

    if (failures.length > 0) {
      console.log('\n' + failures.join('\n'));
    }
    expect(failures).toHaveLength(0);
  });
});
