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

  // W2-F9. The old redactor compiled every prefix of length 20..N into one
  // regex alternation, so the pattern source grew O(N^2) and V8's regex
  // compiler ABORTED the process at ~4 KB — a FATAL ERROR, not a catchable
  // SyntaxError, so no try/catch here could observe it. These run in-process on
  // purpose: if the guard is removed, the worker dies rather than failing.
  describe('W2-F9 large values do not abort the process', () => {
    for (const size of [4_000, 64_000, 1_000_000]) {
      it(`redacts a ${size}-byte value`, () => {
        const value = `sk-${'A'.repeat(size - 3)}`;
        const secret = asSecret(Buffer.from(value, 'utf8'));
        const result = redact(`before ${value} after`, [secret]);
        expect(result.count).toBe(1);
        expect(result.text).toBe('before «redacted» after');
      });
    }

    it('keeps the >= 20 char prefix rule at every size', () => {
      const value = `sk-${'ABCDEFGHIJ'.repeat(500)}`;
      const secret = asSecret(Buffer.from(value, 'utf8'));
      const result = redact(`truncated: ${value.slice(0, 20)} ...`, [secret]);
      expect(result.text).not.toContain(value.slice(0, 20));
      expect(result.text).toBe('truncated: «redacted» ...');
    });
  });

  // W2-F5/F6. Coverage that was measured as missing against the real CLI.
  describe('transformation coverage', () => {
    const SENTINEL = 'sk-W2SENTINEL-sdk-11112222333344445555';
    const secret = asSecret(Buffer.from(SENTINEL, 'utf8'));

    it('redacts lowercase hex (F6)', () => {
      const hex = Buffer.from(SENTINEL, 'utf8').toString('hex');
      const result = redact(`hex=${hex}`, [secret]);
      expect(result.text).not.toContain(hex);
      expect(result.text).toBe('hex=«redacted»');
    });

    it('redacts uppercase hex', () => {
      const hex = Buffer.from(SENTINEL, 'utf8').toString('hex').toUpperCase();
      const result = redact(`hex=${hex}`, [secret]);
      expect(result.text).not.toContain(hex);
    });

    it('redacts the suffix left behind by a newline split (F5)', () => {
      // The exact shape the CLI probe produced: the head is a prefix (always
      // caught) and the tail is a SUFFIX, which the prefix-only variant list
      // never matched, so concatenation recovered the value exactly.
      const head = SENTINEL.slice(0, 10);
      const tail = SENTINEL.slice(10);
      const result = redact(`withNewline=${head}\n${tail}`, [secret]);
      expect(result.text).not.toContain(tail);
      expect(result.text.replace(/«redacted»/g, '').replace(/\s/g, '')).toBe('withNewline=');
    });

    it('redacts an interior fragment of at least 20 characters', () => {
      const middle = SENTINEL.slice(9, 33);
      expect(middle.length).toBeGreaterThanOrEqual(20);
      const result = redact(`fragment ${middle} end`, [secret]);
      expect(result.text).toBe('fragment «redacted» end');
    });

    it('leaves a fragment shorter than the 20-character window alone', () => {
      // Stated plainly rather than glossed: below the window there is no
      // coverage, and pretending otherwise would be the defect.
      const short = SENTINEL.slice(9, 28).slice(0, 19);
      const result = redact(`fragment ${short} end`, [secret]);
      expect(result.count).toBe(0);
      expect(result.text).toContain(short);
    });
  });

  describe('labels (W2-F31)', () => {
    it('falls back to the generic token for a label that is not an identifier', () => {
      const secret = asSecret(Buffer.from('verylongsecretkey123', 'utf8'));
      const labels = new Map([[secret, 'A"><img src=x>']]);
      const result = redact('contains verylongsecretkey123 in it', [secret], labels);
      expect(result.text).toBe('contains «redacted» in it');
      expect(result.text).not.toContain('<img');
    });

    it('labels each value with its own key when several are live', () => {
      const first = asSecret(Buffer.from('firstsecretvalue1234', 'utf8'));
      const second = asSecret(Buffer.from('secondsecretvalue567', 'utf8'));
      const labels = new Map([
        [first, 'OPENAI_API_KEY'],
        [second, 'STRIPE_SECRET_KEY'],
      ]);
      const result = redact(
        'a=firstsecretvalue1234 b=secondsecretvalue567',
        [first, second],
        labels,
      );
      expect(result.text).toBe('a=«redacted:OPENAI_API_KEY» b=«redacted:STRIPE_SECRET_KEY»');
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
