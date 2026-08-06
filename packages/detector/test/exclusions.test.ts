import { describe, it, expect } from 'vitest';
import { isExcluded, exclusionReason } from '../src/exclusions.js';

describe('exclusions', () => {
  const testCases = [
    { name: 'git-sha (40-char)', candidate: 'e83c5163316f89bfbde7d9ab23ca2e25604af290', shouldExclude: true },
    { name: 'uuid', candidate: '550e8400-e29b-41d4-a716-446655440000', shouldExclude: true },
    { name: 'digest (sha512-)', candidate: 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==', shouldExclude: true },
    { name: 'digest (sha256:)', candidate: 'sha256:9c8f7e6d5c4b3a2918f7e6d5c4b3a2918f7e6d5c4b3a2918f7e6d5c4b3a29187', shouldExclude: true },
    { name: 'filesystem-path (Windows)', candidate: String.raw`C:\Users\Developer\AppData\Local\Programs\Microsoft VS Code\resources`, shouldExclude: true },
    { name: 'filesystem-path (Unix)', candidate: '/usr/local/lib/node_modules/typescript/lib/tsserverlibrary.js', shouldExclude: true },
    { name: 'plain-url', candidate: 'https://registry.npmjs.org/@types/node/-/node-22.10.2.tgz', shouldExclude: true },
    { name: 'hex-colour', candidate: '#2563eb', shouldExclude: true },
    { name: 'iso-timestamp', candidate: '2026-08-07T03:14:15.926Z', shouldExclude: true },
    { name: 'semver (full)', candidate: '1.2.3-beta.4+build.567', shouldExclude: true },
    { name: 'semver (range)', candidate: '^18.3.1', shouldExclude: true },
    { name: 'repeated-char', candidate: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', shouldExclude: true },
    { name: 'dictionary-text (camelCase method)', candidate: 'getUserAuthenticationTokenFromSessionStorageOrRedirectToLoginPage', shouldExclude: true },
    { name: 'dictionary-text (camelCase error)', candidate: 'handleAsynchronousValidationErrorsWithRetryAndExponentialBackoff', shouldExclude: true },
    { name: 'numeric', candidate: '0123456789012345678901234567890123456789', shouldExclude: true },
    { name: 'non-latin-prose', candidate: '您好世界这是一个测试字符串用于验证检测器不会误报中文文本内容', shouldExclude: true },
    { name: 'x64-with-zeros', candidate: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX0000', shouldExclude: false },
    { name: 'jwt-three-part', candidate: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwIn0.XXXXXXXXXXXXXXXXXXXXXXXXXXXX', shouldExclude: false },
  ];

  testCases.forEach((tc) => {
    it(`should ${tc.shouldExclude ? 'exclude' : 'not exclude'}: ${tc.name}`, () => {
      const result = isExcluded(tc.candidate, { before: '', after: '' });
      expect(result).toBe(tc.shouldExclude);
    });
  });

  it('should exclude with integrity context', () => {
    const candidate = 'z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==';
    expect(isExcluded(candidate, { before: 'integrity="', after: '' })).toBe(true);
  });

  it('should return non-empty reason when excluded', () => {
    const testCases = [
      { candidate: 'e83c5163316f89bfbde7d9ab23ca2e25604af290', before: '', after: '' },
      { candidate: '#2563eb', before: '', after: '' },
    ];
    testCases.forEach((tc) => {
      const reason = exclusionReason(tc.candidate, { before: tc.before, after: tc.after });
      expect(reason).not.toBeNull();
      expect(reason).toBeTruthy();
    });
  });

  it('should return null reason when not excluded', () => {
    const testCases = [
      { candidate: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX0000', before: '', after: '' },
      { candidate: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwIn0.XXXXXXXXXXXXXXXXXXXXXXXXXXXX', before: '', after: '' },
    ];
    testCases.forEach((tc) => {
      const reason = exclusionReason(tc.candidate, { before: tc.before, after: tc.after });
      expect(reason).toBeNull();
    });
  });
});
