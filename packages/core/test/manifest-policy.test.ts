import { describe, it, expect } from 'vitest';
import { Manifest } from '@envseal/protocol';

/**
 * policy.egress manifest section (SEP/1 minor addition).
 *
 * The schema is the boundary: entries that would make enforcement ambiguous
 * (URLs, ports, schemes, empty allowlists) must be rejected at parse time so
 * the enforcement layer can trust every surviving entry blindly.
 */
describe('policy.egress manifest section', () => {
  const base = { version: 1 as const, entries: [] };

  it('parses a project with no policy exactly as before', () => {
    const result = Manifest.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy).toBeUndefined();
    }
  });

  it('accepts an allowlist with plain hosts and wildcards', () => {
    const result = Manifest.safeParse({
      ...base,
      policy: {
        egress: {
          mode: 'allowlist',
          allow: ['api.openai.com', '*.openai.com', 'registry.npmjs.org'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts warn mode with an empty allow array', () => {
    const result = Manifest.safeParse({
      ...base,
      policy: { egress: { mode: 'warn', allow: [] } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects allowlist mode with no entries — a wall with no gate', () => {
    const result = Manifest.safeParse({
      ...base,
      policy: { egress: { mode: 'allowlist', allow: [] } },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['https://api.example.com', 'a full URL'],
    ['http://x.test', 'an http scheme'],
    ['api.example.com:8443', 'a port suffix'],
    ['user@api.example.com', 'userinfo'],
    ['api example com', 'whitespace'],
    ['', 'the empty string'],
  ])('rejects %s (%s)', (entry) => {
    const result = Manifest.safeParse({
      ...base,
      policy: { egress: { mode: 'warn', allow: [entry] } },
    });
    expect(result.success, `expected rejection of "${String(entry)}"`).toBe(false);
  });

  it('rejects an unknown mode value', () => {
    const result = Manifest.safeParse({
      ...base,
      policy: { egress: { mode: 'block-everything', allow: [] } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside policy (strict surface)', () => {
    const result = Manifest.safeParse({
      ...base,
      policy: { egress: { mode: 'warn' }, extra: true },
    });
    expect(result.success).toBe(false);
  });
});
