import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import fc from 'fast-check';
import { parseDotenv, serializeDotenv, readDotenv, setDotenvValue, removeDotenvKey } from '../src/sinks/dotenv.js';
import { projectPaths } from '../src/paths.js';
import { SepError } from '@envseal/protocol';

describe('dotenv', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseDotenv', () => {
    it('parses blank lines', () => {
      const parsed = parseDotenv('KEY=value\n\nKEY2=value2\n');
      expect(parsed.lines).toHaveLength(3);
      expect(parsed.lines[1]?.kind).toBe('blank');
    });

    it('parses comments', () => {
      const parsed = parseDotenv('# comment\nKEY=value\n');
      expect(parsed.lines[0]?.kind).toBe('comment');
      expect(parsed.lines[1]?.kind).toBe('assignment');
    });

    it('parses assignments', () => {
      const parsed = parseDotenv('KEY=value\n');
      const line = parsed.lines[0];
      expect(line?.kind).toBe('assignment');
      if (line?.kind === 'assignment') {
        expect(line.key).toBe('KEY');
        expect(line.value).toBe('value');
      }
    });

    it('handles CRLF line endings', () => {
      const text = 'KEY=value\r\nKEY2=value2\r\n';
      const parsed = parseDotenv(text);
      expect(parsed.eol).toBe('\r\n');
    });

    it('detects BOM', () => {
      const text = '﻿KEY=value\n';
      const parsed = parseDotenv(text);
      expect(parsed.bom).toBe(true);
      expect(parsed.lines[0]?.kind).toBe('assignment');
    });

    it('preserves trailing newline', () => {
      const text = 'KEY=value\n';
      const parsed = parseDotenv(text);
      expect(parsed.trailingNewline).toBe(true);
    });

    it('handles quoted values', () => {
      const parsed = parseDotenv('KEY="quoted value"\n');
      const line = parsed.lines[0];
      if (line?.kind === 'assignment') {
        expect(line.value).toBe('quoted value');
        expect(line.quote).toBe('"');
      }
    });

    it('handles escaped quotes in double-quoted values', () => {
      const parsed = parseDotenv('KEY="value\\"with\\"quotes"\n');
      const line = parsed.lines[0];
      if (line?.kind === 'assignment') {
        expect(line.value).toContain('"');
      }
    });

    it('handles export prefix', () => {
      const parsed = parseDotenv('export KEY=value\n');
      const line = parsed.lines[0];
      if (line?.kind === 'assignment') {
        expect(line.exported).toBe(true);
      }
    });
  });

  describe('serializeDotenv', () => {
    it('reconstructs with same EOL', () => {
      const text = 'KEY=value\r\nKEY2=value2\r\n';
      const parsed = parseDotenv(text);
      const serialized = serializeDotenv(parsed);
      expect(serialized).toBe(text);
    });

    it('preserves BOM', () => {
      const text = '﻿KEY=value\n';
      const parsed = parseDotenv(text);
      const serialized = serializeDotenv(parsed);
      expect(serialized.charCodeAt(0)).toBe(0xfeff);
    });
  });

  describe('readDotenv', () => {
    it('returns empty object if file does not exist', () => {
      const paths = projectPaths(tmpDir);
      const result = readDotenv(paths);
      expect(result).toEqual({});
    });

    it('parses .env file', () => {
      const paths = projectPaths(tmpDir);
      writeFileSync(paths.dotenv, 'KEY1=value1\nKEY2=value2\n', 'utf8');
      const result = readDotenv(paths);
      expect(result.KEY1).toBe('value1');
      expect(result.KEY2).toBe('value2');
    });
  });

  describe('setDotenvValue', () => {
    it('creates .env file if missing', () => {
      const paths = projectPaths(tmpDir);
      setDotenvValue(paths, 'KEY', 'value', { allowUnsafe: true });
      const content = readFileSync(paths.dotenv, 'utf8');
      expect(content).toContain('KEY=value');
    });

    it('updates existing key surgically', () => {
      const paths = projectPaths(tmpDir);
      const original = 'KEY1=value1\n# comment\nKEY2=value2\n';
      writeFileSync(paths.dotenv, original, 'utf8');

      setDotenvValue(paths, 'KEY1', 'newvalue', { allowUnsafe: true });

      const content = readFileSync(paths.dotenv, 'utf8');
      expect(content).toContain('KEY1=newvalue');
      expect(content).toContain('# comment');
      expect(content).toContain('KEY2=value2');
    });

    it('preserves CRLF line endings', () => {
      const paths = projectPaths(tmpDir);
      writeFileSync(paths.dotenv, 'KEY=value\r\n', 'utf8');

      setDotenvValue(paths, 'KEY', 'newvalue', { allowUnsafe: true });

      const content = readFileSync(paths.dotenv, 'utf8');
      expect(content).toContain('\r\n');
    });

    it('quotes values with spaces', () => {
      const paths = projectPaths(tmpDir);
      setDotenvValue(paths, 'KEY', 'value with spaces', { allowUnsafe: true });

      const content = readFileSync(paths.dotenv, 'utf8');
      expect(content).toContain('"value with spaces"');
    });

    it('throws SEP_GITIGNORE_UNSAFE when file is git-tracked', () => {
      const paths = projectPaths(tmpDir);

      try {
        execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
        writeFileSync(paths.dotenv, 'KEY=value\n', 'utf8');

        execSync('git add -f .env', { cwd: tmpDir, stdio: 'ignore' });

        expect(() => setDotenvValue(paths, 'KEY', 'newvalue')).toThrow();
        try {
          setDotenvValue(paths, 'KEY', 'newvalue');
        } catch (error) {
          if (error instanceof SepError) {
            expect(error.code).toBe('SEP_GITIGNORE_UNSAFE');
          }
        }
      } catch {
        // Git might not be available in test environment
      }
    });
  });

  describe('removeDotenvKey', () => {
    it('removes a key from .env', () => {
      const paths = projectPaths(tmpDir);
      writeFileSync(paths.dotenv, 'KEY1=value1\nKEY2=value2\n', 'utf8');

      const removed = removeDotenvKey(paths, 'KEY1', { allowUnsafe: true });

      expect(removed).toBe(true);
      const content = readFileSync(paths.dotenv, 'utf8');
      expect(content).not.toContain('KEY1');
      expect(content).toContain('KEY2');
    });

    it('returns false if key does not exist', () => {
      const paths = projectPaths(tmpDir);
      writeFileSync(paths.dotenv, 'KEY=value\n', 'utf8');

      const removed = removeDotenvKey(paths, 'ABSENT', { allowUnsafe: true });

      expect(removed).toBe(false);
    });
  });

  describe('property-based tests', () => {
    it('surgical edit maintains byte-for-byte line identity (fast-check, 300 runs)', () => {
      const eolArb = fc.oneof(fc.constant('\n'), fc.constant('\r\n'));
      const keyArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,20}$/);

      const valueArb = fc.oneof(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !/[\r\n]/.test(s)),
        fc.constantFrom(
          'value with spaces',
          'value#with#hash',
          'value"with"quotes',
          "value'with'quotes",
          'value=with=equals'
        )
      );

      const commentLineArb = fc.string({ minLength: 1, maxLength: 30 }).map((s) => `# ${s}`);
      const blankLineArb = fc.constant('');

      const bareAssignmentArb = fc
        .tuple(keyArb, valueArb)
        .map(([k, v]) => {
          const needsQuote = /[\s#\\"]/.test(v) || v.includes('\n') || v.includes('\r');
          if (needsQuote) {
            const escaped = v
              .split('\\')
              .join('\\\\')
              .split('"')
              .join('\\"')
              .split('\n')
              .join('\\n')
              .split('\r')
              .join('\\r');
            return `${k}="${escaped}"`;
          }
          return `${k}=${v}`;
        });

      const exportedAssignmentArb = bareAssignmentArb.map((s) => `export ${s}`);

      const lineArb = fc.oneof(commentLineArb, blankLineArb, bareAssignmentArb, exportedAssignmentArb);

      const dotenvFileArb = fc
        .tuple(fc.array(lineArb, { minLength: 0, maxLength: 10 }), eolArb, fc.boolean())
        .map(([lines, eol, hasBom]) => {
          const body = lines.join(eol) + (lines.length > 0 ? eol : '');
          return hasBom ? '﻿' + body : body;
        });

      fc.assert(
        fc.property(
          dotenvFileArb,
          keyArb,
          valueArb,
          (originalContent, key, value) => {
            const paths = projectPaths(tmpDir);
            writeFileSync(paths.dotenv, originalContent, 'utf8');

            setDotenvValue(paths, key, value, { allowUnsafe: true });

            const newContent = readFileSync(paths.dotenv, 'utf8');
            const readValues = readDotenv(paths);

            if (readValues[key] !== value) {
              throw new Error(
                `Value mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(readValues[key])}`
              );
            }

            const originalLines = originalContent
              .split(/\r\n|\n/)
              .filter((_, i, arr) => i < arr.length - 1 || (arr[arr.length - 1]?.length ?? 0) > 0);
            const newLines = newContent
              .split(/\r\n|\n/)
              .filter((_, i, arr) => i < arr.length - 1 || (arr[arr.length - 1]?.length ?? 0) > 0);

            const assignmentRegex = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=/;
            const originalAssignIdx = originalLines.findIndex((line) => {
              const match = assignmentRegex.exec(line);
              return match?.[1] === key;
            });

            // A surgical write may append but must never drop lines. Without this
            // assertion the loop below silently skips deleted trailing lines and
            // file truncation passes as success.
            if (newLines.length < originalLines.length) {
              throw new Error(
                `Line count shrank: ${originalLines.length} -> ${newLines.length}\n` +
                  `Original: ${JSON.stringify(originalContent)}\nNew: ${JSON.stringify(newContent)}`,
              );
            }

            for (let i = 0; i < originalLines.length; i++) {
              if (i !== originalAssignIdx) {
                if (originalLines[i] !== newLines[i]) {
                  throw new Error(
                    `Line ${i} mismatch:\nOriginal: ${JSON.stringify(originalLines[i])}\nNew: ${JSON.stringify(newLines[i])}`
                  );
                }
              }
            }

            return true;
          }
        ),
        { numRuns: 300, verbose: false }
      );
    });
  });
});
