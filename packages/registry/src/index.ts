import type { Provider, ProviderKey } from './schema.js';
import { loadProviders } from './load.js';

let cache: Provider[] | null = null;

function getCache(): Provider[] {
  if (cache === null) {
    cache = loadProviders();
  }
  return cache;
}

export function allProviders(): Provider[] {
  return getCache();
}

export function getProvider(id: string): Provider | undefined {
  return getCache().find((p) => p.id === id);
}

export function findKey(
  envVar: string
): { provider: Provider; key: ProviderKey } | undefined {
  const providers = getCache();
  for (const provider of providers) {
    const key = provider.keys.find((k) => k.envVar === envVar);
    if (key !== undefined) {
      return { provider, key };
    }
  }
  return undefined;
}

export function allProbeHosts(): Set<string> {
  const hosts = new Set<string>();
  const providers = getCache();

  for (const provider of providers) {
    for (const key of provider.keys) {
      if (key.verify?.url !== undefined) {
        try {
          const url = new URL(key.verify.url);
          hosts.add(url.hostname);
        } catch {
          // Invalid URL, skip
        }
      }
    }
  }

  return hosts;
}

export function allPrefixPatterns(): Array<{
  providerId: string;
  envVar: string;
  prefix?: string;
  pattern?: string;
}> {
  const patterns: Array<{
    providerId: string;
    envVar: string;
    prefix?: string;
    pattern?: string;
  }> = [];

  const providers = getCache();
  for (const provider of providers) {
    for (const key of provider.keys) {
      patterns.push({
        providerId: provider.id,
        envVar: key.envVar,
        prefix: key.format.prefix,
        pattern: key.format.pattern,
      });
    }
  }

  return patterns;
}

export type { Provider, ProviderKey };
