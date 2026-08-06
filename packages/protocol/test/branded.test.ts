import { describe, it, expect } from 'vitest';
import { asSecret, secretFromUtf8, zero, secretLength, lengthBucket, fingerprint } from '../src/branded.js';

describe('secretFromUtf8 / asSecret', () => {
  it('wraps a buffer with utf8 contents', () => {
    const s = secretFromUtf8('hello');
    expect(s instanceof Buffer).toBe(true);
    expect(secretLength(s)).toBe(5);
    expect(s.toString('utf8')).toBe('hello');
  });

  it('asSecret preserves the underlying buffer identity', () => {
    const buf = Buffer.from('abc');
    expect(asSecret(buf)).toBe(buf);
  });
});

describe('zero', () => {
  it('leaves an all-zero buffer', () => {
    const s = secretFromUtf8('a-secret-value-12345');
    expect(Buffer.from(s).includes(0)).toBe(false);
    const len = secretLength(s);
    zero(s);
    expect(secretLength(s)).toBe(len);
    expect(Buffer.from(s).every((b) => b === 0)).toBe(true);
  });

  it('is idempotent', () => {
    const s = secretFromUtf8('x');
    zero(s);
    const zeroed = Buffer.from(s);
    zero(s);
    expect(Buffer.from(s).equals(zeroed)).toBe(true);
  });
});

describe('lengthBucket', () => {
  const cases: Array<[number, string]> = [
    [0, '<16'],
    [1, '<16'],
    [15, '<16'],
    [16, '16-31'],
    [31, '16-31'],
    [32, '32-47'],
    [47, '32-47'],
    [48, '48-63'],
    [63, '48-63'],
    [64, '64-95'],
    [95, '64-95'],
    [96, '96-127'],
    [127, '96-127'],
    [128, '128+'],
    [311, '128+'],
  ];

  for (const [len, expected] of cases) {
    it(`maps length ${len} to ${expected}`, () => {
      expect(lengthBucket(secretFromUtf8('x'.repeat(len)))).toBe(expected);
    });
  }
});

describe('fingerprint', () => {
  it('is deterministic for the same value and salt', () => {
    const s = secretFromUtf8('sk-abc123');
    const salt = Buffer.from('project-salt');
    expect(fingerprint(s, salt)).toBe(fingerprint(s, salt));
  });

  it('varies with the value', () => {
    const salt = Buffer.from('project-salt');
    const a = fingerprint(secretFromUtf8('value-one'), salt);
    const b = fingerprint(secretFromUtf8('value-two'), salt);
    expect(a).not.toBe(b);
  });

  it('varies with the salt', () => {
    const s = secretFromUtf8('sk-abc123');
    const a = fingerprint(s, Buffer.from('salt-a'));
    const b = fingerprint(s, Buffer.from('salt-b'));
    expect(a).not.toBe(b);
    expect(a).not.toBe(b);
  });

  it('matches the fp_ + 8 hex chars format and never leaks the value', () => {
    const s = secretFromUtf8('sk-very-secret-value');
    const fp = fingerprint(s, Buffer.from('salt'));
    expect(fp).toMatch(/^fp_[0-9a-f]{8}$/);
    expect(fp).not.toContain('secret');
  });
});
