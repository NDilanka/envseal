import { describe, it, expect } from 'vitest';
import { allProbeHosts, findKey, getProvider } from '../src/index.js';

describe('Registry API', () => {
  it('allProbeHosts should be non-empty', () => {
    const hosts = allProbeHosts();
    expect(hosts.size).toBeGreaterThan(0);
  });

  it('allProbeHosts should contain api.openai.com', () => {
    const hosts = allProbeHosts();
    expect(hosts.has('api.openai.com')).toBe(true);
  });

  it('findKey should resolve OPENAI_API_KEY', () => {
    const result = findKey('OPENAI_API_KEY');
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe('openai');
    expect(result?.key.envVar).toBe('OPENAI_API_KEY');
  });

  it('getProvider should return undefined for unknown provider', () => {
    const result = getProvider('nope');
    expect(result).toBeUndefined();
  });

  it('getProvider should return openai provider', () => {
    const result = getProvider('openai');
    expect(result).toBeDefined();
    expect(result?.name).toBe('OpenAI');
  });
});
