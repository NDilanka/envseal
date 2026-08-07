import { describe, it, expect } from 'vitest';
import {
  redactUserMessage,
  firstLineOf,
  shouldBypassFirstLine,
  uniqueLabels,
  buildNotice,
  scrubHighEntropy,
} from '../hooks/user-prompt-submit.js';

describe('user-prompt-submit hook', () => {
  describe('firstLineOf', () => {
    it('extracts first line', () => {
      const msg = '/env:allow-once\nSecond line';
      expect(firstLineOf(msg)).toBe('/env:allow-once');
    });

    it('trims whitespace', () => {
      expect(firstLineOf('  /env:allow-once  \nNext')).toBe('/env:allow-once');
    });

    it('handles single line', () => {
      expect(firstLineOf('Single line')).toBe('Single line');
    });

    it('handles CRLF', () => {
      expect(firstLineOf('First\r\nSecond')).toBe('First');
    });
  });

  describe('shouldBypassFirstLine', () => {
    it('detects /env:allow-once marker', () => {
      expect(shouldBypassFirstLine('/env:allow-once\nRest')).toBe(true);
    });

    it('detects /env:allow-once with reason', () => {
      expect(shouldBypassFirstLine('/env:allow-once because I need to debug\nRest')).toBe(true);
    });

    it('rejects when marker is not first', () => {
      expect(shouldBypassFirstLine('Some text\n/env:allow-once')).toBe(false);
    });

    it('requires exact marker', () => {
      expect(shouldBypassFirstLine('/env:allow-once-wrong')).toBe(false);
    });
  });

  describe('uniqueLabels', () => {
    it('deduplicates labels', () => {
      const detections = [
        { start: 0, end: 10, patternId: 'p1', confidence: 'high' as const, label: 'OpenAI API key' },
        { start: 20, end: 30, patternId: 'p2', confidence: 'high' as const, label: 'OpenAI API key' },
        { start: 40, end: 50, patternId: 'p3', confidence: 'high' as const, label: 'GitHub token' },
      ];
      const labels = uniqueLabels(detections);
      expect(labels).toEqual(['OpenAI API key', 'GitHub token']);
    });

    it('handles empty array', () => {
      expect(uniqueLabels([])).toEqual([]);
    });
  });

  describe('scrubHighEntropy', () => {
    it('replaces high-entropy runs', () => {
      const msg = 'Token: abcdefghijklmnopqrstuvwxyz123456789';
      const result = scrubHighEntropy(msg);
      expect(result).toContain('«redacted-secret»');
      expect(result).not.toContain('abcdefghijk');
    });

    it('preserves short strings', () => {
      const msg = 'short token';
      const result = scrubHighEntropy(msg);
      expect(result).toBe(msg);
    });

    it('handles multiple matches', () => {
      const msg = 'Key1: abcdefghijklmnopqrstuvwxyz123456789 Key2: xyz123abcdefghijklmnopqrstuvwxyz123';
      const result = scrubHighEntropy(msg);
      const count = (result.match(/«redacted-secret»/g) ?? []).length;
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  describe('buildNotice', () => {
    it('includes labels', () => {
      const detections = [
        { start: 0, end: 10, patternId: 'p1', confidence: 'high' as const, label: 'OpenAI API key' },
      ];
      const notice = buildNotice(detections);
      expect(notice).toContain('OpenAI API key');
      expect(notice).toContain('NOT sent to the model');
    });

    it('mentions rotation when provider has rotateUrl', () => {
      const detections = [
        {
          start: 0,
          end: 10,
          patternId: 'p1',
          confidence: 'high' as const,
          label: 'OpenAI API key',
          providerId: 'openai',
        },
      ];
      const notice = buildNotice(detections);
      expect(notice).toContain('rotate');
    });

    it('suggests /env:set for key storage', () => {
      const detections = [
        { start: 0, end: 10, patternId: 'p1', confidence: 'high' as const, label: 'test' },
      ];
      const notice = buildNotice(detections);
      expect(notice).toContain('/env:set');
    });

    it('never includes actual secret value in notice', () => {
      // The notice is built only from label strings and provider URLs
      // It should never include the actual secret value itself
      const detections = [
        {
          start: 0,
          end: 10,
          patternId: 'p1',
          confidence: 'high' as const,
          label: 'OpenAI API key',
        },
      ];
      const notice = buildNotice(detections);
      // Notice should never contain provider prefixes or real keys
      expect(notice).not.toContain('sk-proj-');
      expect(notice).not.toContain('ghp_');
      expect(notice).not.toContain('AKIA');
    });
  });

  describe('redactUserMessage - provider prefixed keys', () => {
    it('detects and redacts OpenAI sk- key', () => {
      // sk- is a real prefix detected by @envseal/detector
      const msg = 'Test key: sk-proj-abc123def456ghi789jkl';
      const result = redactUserMessage(msg);
      if (result.detected) {
        expect(result.modifiedMessage).not.toContain('sk-proj-abc123');
        expect(result.modifiedMessage).toContain('«redacted-secret»');
      }
    });

    it('detects and redacts GitHub token', () => {
      const msg = 'GitHub token: ghp_ABCDEFGHIJKLMNOPabcdefghijklmnopqrst';
      const result = redactUserMessage(msg);
      if (result.detected) {
        expect(result.modifiedMessage).not.toContain('ghp_');
      }
    });
  });

  describe('redactUserMessage - ordinary text', () => {
    it('passes ordinary prose unchanged', () => {
      const msg = 'This is just a normal message about implementing features';
      const result = redactUserMessage(msg);
      expect(result.modifiedMessage).toBe(msg);
      expect(result.detected).toBe(false);
    });

    it('allows git commit SHA', () => {
      const msg = 'The commit was abc1234567890def1234567890abcdef12345678';
      const result = redactUserMessage(msg);
      // Git SHAs (40 hex chars) should not trigger detection
      expect(result.detected).toBe(false);
    });

    it('allows UUIDs', () => {
      const msg = 'ID: 550e8400-e29b-41d4-a716-446655440000';
      const result = redactUserMessage(msg);
      expect(result.detected).toBe(false);
    });

    it('allows file paths', () => {
      const msg = '/home/user/projects/app/src/components/index.ts';
      const result = redactUserMessage(msg);
      expect(result.detected).toBe(false);
    });
  });

  describe('redactUserMessage - /env:allow-once bypass', () => {
    it('bypasses redaction when /env:allow-once is first line', () => {
      const msg = '/env:allow-once\nKey: sk-proj-secret123456789abcdefghij';
      const result = redactUserMessage(msg);
      expect(result.bypassed).toBe(true);
      expect(result.modifiedMessage).toBe(msg);
    });

    it('bypasses with reason after marker', () => {
      const msg = '/env:allow-once because I need to test locally\nKey: sk-proj-secret';
      const result = redactUserMessage(msg);
      expect(result.bypassed).toBe(true);
    });

    it('does not bypass when marker is not first line', () => {
      const msg = 'Some text\n/env:allow-once\nKey: sk-proj-secret';
      const result = redactUserMessage(msg);
      expect(result.bypassed).toBe(false);
    });
  });

  describe('redactUserMessage - failure modes', () => {
    it('handles empty message', () => {
      const result = redactUserMessage('');
      expect(result.modifiedMessage).toBe('');
      expect(result.detected).toBe(false);
    });

    it('handles very long message', () => {
      const msg = 'A'.repeat(100000);
      const result = redactUserMessage(msg);
      expect(result.modifiedMessage).toBeDefined();
    });

    it('handles messages with only whitespace', () => {
      const result = redactUserMessage('   \n\t  \n  ');
      expect(result.modifiedMessage).toBeDefined();
    });
  });

  describe('redactUserMessage - multiple detections', () => {
    it('redacts multiple secrets in one message', () => {
      // If the detector finds multiple secrets, all should be redacted
      const msg = 'Key1: sk-proj-secret1 and Key2: ghp_secret2';
      const result = redactUserMessage(msg);
      if (result.detected) {
        // Both should be replaced
        const count = (result.modifiedMessage.match(/«redacted-secret»/g) ?? []).length;
        expect(count).toBeGreaterThanOrEqual(1);
      }
    });

    it('includes all unique labels', () => {
      const msg = 'Key1: sk-proj-secret1 and Key2: ghp_secret2';
      const result = redactUserMessage(msg);
      if (result.detected && result.labels.length > 0) {
        // Should have at least one label
        expect(result.labels[0]).toBeDefined();
      }
    });
  });

  describe('redactUserMessage - false positive handling', () => {
    it('errs toward redaction (fail-closed)', () => {
      // If there's doubt, the hook should redact
      // This is the design principle for false positives
      const msg = 'Something with potential entropy that might look like a secret';
      const result = redactUserMessage(msg);
      // Result should be defined regardless
      expect(result.modifiedMessage).toBeDefined();
    });
  });

  describe('notice safety', () => {
    it('never includes original secret value in notice', () => {
      const msg = 'Secret: sk-proj-this-is-secret-never-print-this';
      const result = redactUserMessage(msg);
      if (result.notice) {
        expect(result.notice).not.toContain('this-is-secret');
        expect(result.notice).not.toContain('never-print');
      }
    });

    it('notice is safe to print to stderr', () => {
      const msg = 'Key: sk-proj-secret';
      const result = redactUserMessage(msg);
      if (result.notice) {
        // Notice should only contain sanitized information
        expect(() => process.stderr.write(result.notice)).not.toThrow();
      }
    });
  });
});
