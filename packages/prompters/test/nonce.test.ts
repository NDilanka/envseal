import { describe, it, expect } from 'vitest';
import { makeDisplayNonce } from '../src/types.js';

describe('makeDisplayNonce', () => {
  it('matches the NNNN-NNNN display format', () => {
    expect(makeDisplayNonce()).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('generates 1000 distinct nonces', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(makeDisplayNonce());
    }
    expect(seen.size).toBe(1000);
  });
});