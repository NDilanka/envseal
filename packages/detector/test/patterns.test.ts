import { describe, it, expect } from 'vitest';
import { allPatterns, isBoundedRegistryPattern, isSpecificRegistryPattern } from '../src/patterns.js';
import { detect } from '../src/index.js';

describe('patterns', () => {
  it('should prevent lastIndex regression across multiple calls', () => {
    const patterns1 = allPatterns();
    const gitHubPat = patterns1.find((p) => p.id === 'github-pat');
    expect(gitHubPat).toBeDefined();

    if (!gitHubPat) {
      throw new Error('github-pat pattern not found');
    }

    // Three tokens with exactly 36 characters each (a-z: 26, 0-9: 10)
    const testString =
      'token1: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' +
      'token2: ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' +
      'token3: ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    const scan1 = testString.match(gitHubPat.regex);
    const scan2 = testString.match(gitHubPat.regex);
    const scan3 = testString.match(gitHubPat.regex);

    const count1 = scan1?.length ?? 0;
    const count2 = scan2?.length ?? 0;
    const count3 = scan3?.length ?? 0;

    expect(count1).toBe(3);
    expect(count2).toBe(3);
    expect(count3).toBe(3);
  });

  it('should return fresh RegExp objects on each call', () => {
    const patterns1 = allPatterns();
    const patterns2 = allPatterns();
    const regex1 = patterns1[0]?.regex;
    const regex2 = patterns2[0]?.regex;
    expect(regex1).not.toBe(regex2);
  });

  it('should have g flag on all patterns', () => {
    const patterns = allPatterns();
    for (const pattern of patterns) {
      expect(pattern.regex.flags).toContain('g');
    }
  });

  it('should have unique ids', () => {
    const patterns = allPatterns();
    const ids = patterns.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should detect sk- prefix key', () => {
    const patterns = allPatterns();
    const testString = 'sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it('should detect ghp_ prefix', () => {
    const patterns = allPatterns();
    const testString = 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it('should detect AKIA prefix', () => {
    const patterns = allPatterns();
    const testString = 'AKIAXXXXXXXXXXXXXXXX';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it('should detect AIza prefix', () => {
    const patterns = allPatterns();
    const testString = 'AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it('should detect PEM private key', () => {
    const patterns = allPatterns();
    const testString = '-----BEGIN OPENSSH PRIVATE KEY-----';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it('should detect connection string with inline credentials', () => {
    const patterns = allPatterns();
    const testString = 'postgres://appuser:XXXXXXXXXXXXXXXX@db.example.com:5432/appdb';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  it('should NOT detect git SHA', () => {
    const patterns = allPatterns();
    const testString = 'e83c5163316f89bfbde7d9ab23ca2e25604af290';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(false);
  });

  it('should NOT detect UUID', () => {
    const patterns = allPatterns();
    const testString = '550e8400-e29b-41d4-a716-446655440000';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(false);
  });

  it('should NOT detect postgres without credentials', () => {
    const patterns = allPatterns();
    const testString = 'postgres://localhost:5432/development';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(false);
  });

  it('should NOT detect hex colour', () => {
    const patterns = allPatterns();
    const testString = '#2563eb';
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(testString)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(false);
  });

  it('should detect a 32-char alphanumeric secret inside JSON (H7)', () => {
    const secret = 'aB3cD5eF7gH9jK1mNpQrStUvWxYz0123';
    const detections = detect(`{"secret":"${secret}"}`);
    expect(detections.length).toBeGreaterThan(0);
    expect(detections.some((d) => d.start <= 11 && d.end >= 11 + secret.length)).toBe(true);
  });

  it('should detect Discord pattern-only registry key with high confidence (H8)', () => {
    const token =
      'XXXXXXXXXXXXXXXXXXXXXXXX.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const detections = detect(token);
    expect(detections.some((d) => d.confidence === 'high' && d.providerId === 'discord')).toBe(true);
  });

  it('should detect Auth0 client secret via generic scan in assignment context (H8)', () => {
    const secret = 'aB3cD5eF7gH9jK1mNpQrStUvWxYz0123456789ab';
    const detections = detect(`AUTH0_CLIENT_SECRET=${secret}`);
    expect(detections.length).toBeGreaterThan(0);
  });

  it('should compile bounded specific registry patterns and reject generic ones', () => {
    expect(isBoundedRegistryPattern('^[A-Za-z0-9_-]{32,}$')).toBe(true);
    expect(isSpecificRegistryPattern('^[A-Za-z0-9_-]{32,}$')).toBe(false);
    expect(isSpecificRegistryPattern('^[A-Za-z0-9_-]{24}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{38,}$')).toBe(
      true,
    );
    expect(isBoundedRegistryPattern('^[A-Za-z0-9]+')).toBe(false);
    expect(isBoundedRegistryPattern('a'.repeat(256))).toBe(false);
  });
});
