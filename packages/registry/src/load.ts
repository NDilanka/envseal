import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Provider } from './schema.js';
import { ProviderSchema } from './schema.js';

export function loadProviders(): Provider[] {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const providersDir = join(currentDir, '..', 'providers');

  const allFiles: string[] = readdirSync(providersDir, {
    encoding: 'utf-8',
  });
  const files = allFiles.filter((file) => file.endsWith('.json')).sort();

  const providers: Provider[] = [];

  for (const file of files) {
    const filePath = join(providersDir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as unknown;
      const parsed = ProviderSchema.safeParse(data);

      if (!parsed.success) {
        throw new Error(`Validation failed: ${parsed.error.message}`);
      }

      providers.push(parsed.data);
    } catch (error) {
      throw new Error(
        `Failed to load provider ${file}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return providers;
}
