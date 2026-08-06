import { asSecret } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from './paths.js';
import { readDotenv } from './sinks/dotenv.js';

export type PresenceSource = 'process-env' | 'dotenv' | 'sink' | 'absent';

export interface Presence {
  key: string;
  present: boolean;
  source: PresenceSource;
  value: SecretValue | null;
}

export function resolvePresence(paths: ProjectPaths, keys: string[]): Map<string, Presence> {
  const env = process.env;
  const dotenv = readDotenv(paths);
  const out = new Map<string, Presence>();
  for (const key of keys) {
    const envValue = env[key];
    if (envValue !== undefined) {
      out.set(key, {
        key,
        present: true,
        source: 'process-env',
        value: asSecret(Buffer.from(envValue, 'utf8')),
      });
      continue;
    }
    const dotenvValue = dotenv[key];
    if (dotenvValue !== undefined) {
      out.set(key, {
        key,
        present: true,
        source: 'dotenv',
        value: asSecret(Buffer.from(dotenvValue, 'utf8')),
      });
      continue;
    }
    out.set(key, { key, present: false, source: 'absent', value: null });
  }
  return out;
}
