import { asSecret } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from './paths.js';
import { readDotenv } from './sinks/dotenv.js';
import { getSink } from './sinks/registry.js';

export type PresenceSource = 'process-env' | 'dotenv' | 'sink' | 'absent';

export interface Presence {
  key: string;
  present: boolean;
  source: PresenceSource;
  value: SecretValue | null;
}

export interface ResolvePresenceOptions {
  /**
   * Declared sink per key, taken from the manifest (`entry.sink ?? 'dotenv'`).
   * A key mapped to a sink other than 'dotenv' is resolved through that sink,
   * because that is where use()/verify() will actually read it; keys absent
   * from the map keep the process-env/.env check exactly as before.
   */
  sinks?: ReadonlyMap<string, string>;
}

export async function resolvePresence(
  paths: ProjectPaths,
  keys: string[],
  options?: ResolvePresenceOptions,
): Promise<Map<string, Presence>> {
  const env = process.env;
  const dotenv = readDotenv(paths);
  const out = new Map<string, Presence>();
  for (const key of keys) {
    // process.env first for every key: runWithSecrets spawns the child with
    // {...process.env}, so an exported value genuinely reaches the process.
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
    const sinkId = options?.sinks?.get(key);
    if (sinkId !== undefined && sinkId !== 'dotenv') {
      let value: SecretValue | null = null;
      try {
        value = await getSink(sinkId).read(paths, key);
      } catch {
        // A credential-store hiccup (locked keychain, DPAPI failure) must
        // degrade to absent rather than crash describe/status — those are
        // read-only reports that must answer even when a store is unhappy.
        // The error still surfaces where it matters, in use()/verify().
        value = null;
      }
      if (value !== null) {
        out.set(key, { key, present: true, source: 'sink', value });
        continue;
      }
      // No dotenv fallback here: a keychain-declared key is only resolvable
      // through its declared sink, so a hand-written .env line must not make
      // status claim present.
      out.set(key, { key, present: false, source: 'absent', value: null });
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
