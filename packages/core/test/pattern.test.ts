import { describe, it, expect } from 'vitest';
import { SepError } from '@envseal/protocol';
import { compileSafePattern } from '../src/pattern.js';

describe('compileSafePattern', () => {
  it('accepts bounded linearish patterns', () => {
    const re = compileSafePattern('^sk-[A-Za-z0-9]{20,80}$');
    expect(re.test('sk-abcdefghijklmnopqrst')).toBe(true);
  });

  it('rejects nested quantifier ReDoS shapes', () => {
    expect(() => compileSafePattern('(a+)+$')).toThrow(SepError);
    try {
      compileSafePattern('(a+)+$');
    } catch (err) {
      expect(err instanceof SepError).toBe(true);
      if (err instanceof SepError) {
        expect(err.code).toBe('SEP_PATTERN_UNSAFE');
      }
    }
  });

  it('rejects unbounded upper quantifiers', () => {
    expect(() => compileSafePattern('^sk-[A-Za-z0-9]{20,}$')).toThrow(SepError);
  });
});
