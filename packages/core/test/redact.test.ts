import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { asSecret } from '@envseal/protocol';
import { redact } from '../src/redact.js';

describe('redact', () => {
  describe('unit tests', () => {
    it('does not redact secrets shorter than 8 bytes', () => {
      const secret = asSecret(Buffer.from('short', 'utf8'));
      const result = redact('contains short in it', [secret]);
      expect(result.text).toBe('contains short in it');
      expect(result.count).toBe(0);
    });

    it('redacts the raw secret', () => {
      const secret = asSecret(Buffer.from('verylongsecretkey123', 'utf8'));
      const result = redact('prefix verylongsecretkey123 suffix', [secret]);
      expect(result.text).not.toContain('verylongsecretkey123');
      expect(result.text).toContain('«redacted»');
      expect(result.count).toBeGreaterThan(0);
    });

    it('redacts base64 encoding', () => {
      const secret = asSecret(Buffer.from('verylongsecretkey123', 'utf8'));
      const base64 = Buffer.from('verylongsecretkey123', 'utf8').toString('base64');
      const result = redact(`contains ${base64} in it`, [secret]);
      expect(result.text).not.toContain(base64);
      expect(result.text).toContain('«redacted»');
    });

    it('redacts base64url encoding', () => {
      const secret = asSecret(Buffer.from('verylongsecretkey123+/==', 'utf8'));
      const base64url = Buffer.from('verylongsecretkey123+/==', 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      const result = redact(`contains ${base64url} in it`, [secret]);
      expect(result.text).not.toContain(base64url);
    });

    it('redacts URI-encoded form', () => {
      const secret = asSecret(Buffer.from('test@example.com:password123', 'utf8'));
      const encoded = encodeURIComponent('test@example.com:password123');
      const result = redact(`url?creds=${encoded}`, [secret]);
      expect(result.text).not.toContain(encoded);
    });

    it('redacts JSON-escaped form', () => {
      const secret = asSecret(Buffer.from('line1\nline2verylongsecretkey', 'utf8'));
      const result = redact('contains line1\\nline2verylongsecretkey in json', [secret]);
      expect(result.count).toBeGreaterThan(0);
    });

    it('redacts >= 20-char prefixes', () => {
      const secret = asSecret(Buffer.from('verylongsecretkey123extrastuff', 'utf8'));
      const result = redact('truncated: verylongsecretkey123extra...', [secret]);
      expect(result.text).not.toContain('verylongsecretkey123extra');
    });

    it('uses custom labels', () => {
      const secret = asSecret(Buffer.from('verylongsecretkey123', 'utf8'));
      const labels = new Map([[secret, 'TEST_KEY']]);
      const result = redact('contains verylongsecretkey123 in it', [secret], labels);
      expect(result.text).toContain('«redacted:TEST_KEY»');
      expect(result.text).not.toContain('«redacted»');
    });

    it('handles multiple overlapping secrets', () => {
      const long = asSecret(Buffer.from('verylongsecretkey123', 'utf8'));
      const short = asSecret(Buffer.from('verylongsecretkey123extralong', 'utf8'));
      const text = 'contains verylongsecretkey123extralong in it';

      const result = redact(text, [long, short]);
      expect(result.text).not.toContain('verylongsecret');
      expect(result.count).toBeGreaterThan(0);
    });

    it('returns text unchanged when no secrets', () => {
      const text = 'innocent text with no secrets';
      const result = redact(text, []);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });
  });

  describe('property-based tests', () => {
    it('never leaks the raw secret', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 8 }),
          fc.string(),
          (secret, text) => {
            const secretBuf = asSecret(Buffer.from(secret, 'utf8'));
            const combined = text + secret + text;
            const result = redact(combined, [secretBuf]);
            return !result.text.includes(secret);
          }
        )
      );
    });

    it('never leaks base64 encoding', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 8 }),
          fc.string(),
          (secret, text) => {
            const secretBuf = asSecret(Buffer.from(secret, 'utf8'));
            const base64 = Buffer.from(secret, 'utf8').toString('base64');
            const combined = text + base64 + text;
            const result = redact(combined, [secretBuf]);
            return !result.text.includes(base64);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('never leaks URI-encoded form', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 8 }).filter((s) => !/[%\r\n]/.test(s)),
          fc.string(),
          (secret, text) => {
            const secretBuf = asSecret(Buffer.from(secret, 'utf8'));
            const encoded = encodeURIComponent(secret);
            const combined = text + encoded + text;
            const result = redact(combined, [secretBuf]);
            return !result.text.includes(encoded);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('never leaks >= 20-char prefixes', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 20 }),
          fc.string(),
          (secret, text) => {
            const secretBuf = asSecret(Buffer.from(secret, 'utf8'));
            const combined = text + secret.slice(0, 20) + text;
            const result = redact(combined, [secretBuf]);
            return !result.text.includes(secret.slice(0, 20));
          }
        ),
        { numRuns: 50 }
      );
    });
  });

    it('handles multi-byte UTF-8 secrets (emoji, accents)', () => {
      const fc = require('fast-check');
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('🔐secretkey12345678'), // emoji + ASCII
            fc.constant('café_secret_key_12345'), // accented + ASCII (é is 2 bytes)
            fc.constant('密码secretkey1234567'), // Chinese characters (3 bytes each)
            fc.constant('contraseña_secret_1234'), // ñ is 2 bytes
            fc.constant('🎯🎨🔑_verylongsecretkey')  // multiple emoji
          ),
          fc.string(),
          (secret, text) => {
            const secretBuf = asSecret(Buffer.from(secret, 'utf8'));
            const combined = text + secret + text;
            const result = redact(combined, [secretBuf]);
            
            // Verify the raw secret is redacted
            if (result.text.includes(secret)) {
              return false;
            }
            
            // Verify base64 variant is redacted
            const base64 = Buffer.from(secret, 'utf8').toString('base64');
            if (result.text.includes(base64)) {
              return false;
            }
            
            // Verify URI-encoded variant is redacted
            const encoded = encodeURIComponent(secret);
            if (result.text.includes(encoded)) {
              return false;
            }
            
            // Verify JSON-escaped variant is redacted
            const jsonEscaped = JSON.stringify(secret);
            if (jsonEscaped.length >= 3 && result.text.includes(jsonEscaped.slice(1, -1))) {
              return false;
            }
            
            // Verify >= 20-byte prefix is redacted (note: bytes, not chars)
            const buf = Buffer.from(secret, 'utf8');
            if (buf.length >= 20) {
              const prefixBuf = buf.slice(0, 20);
              const prefixStr = prefixBuf.toString('utf8');
              if (result.text.includes(prefixStr)) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
});
