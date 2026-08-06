import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectPaths } from '../src/paths.js';
import { resolvePresence } from '../src/presence.js';

describe('presence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolvePresence', () => {
    it('does not mutate process.env', () => {
      const paths = projectPaths(tmpDir);

      // Create a .env file with some values
      writeFileSync(
        paths.dotenv,
        'TEST_KEY_1=value1\nTEST_KEY_2=value2\n',
        'utf8'
      );

      // Take a snapshot of process.env
      const before = { ...process.env };

      // Resolve presence
      resolvePresence(paths, ['TEST_KEY_1', 'TEST_KEY_2']);

      // Verify process.env is unchanged
      expect(process.env).toEqual(before);
    });

    it('finds values in process.env', () => {
      const paths = projectPaths(tmpDir);
      const originalValue = process.env['ENVSEAL_TEST_KEY_123'] || '';

      try {
        process.env['ENVSEAL_TEST_KEY_123'] = 'process-value';

        const presence = resolvePresence(paths, ['ENVSEAL_TEST_KEY_123']);
        const entry = presence.get('ENVSEAL_TEST_KEY_123');

        expect(entry).not.toBeUndefined();
        expect(entry?.present).toBe(true);
        expect(entry?.source).toBe('process-env');
        expect(entry?.value?.toString('utf8')).toBe('process-value');
      } finally {
        if (originalValue) {
          process.env['ENVSEAL_TEST_KEY_123'] = originalValue;
        } else {
          delete process.env['ENVSEAL_TEST_KEY_123'];
        }
      }
    });

    it('finds values in .env file', () => {
      const paths = projectPaths(tmpDir);
      writeFileSync(paths.dotenv, 'DOTENV_KEY=dotenv-value\n', 'utf8');

      const presence = resolvePresence(paths, ['DOTENV_KEY']);
      const entry = presence.get('DOTENV_KEY');

      expect(entry).not.toBeUndefined();
      expect(entry?.present).toBe(true);
      expect(entry?.source).toBe('dotenv');
      expect(entry?.value?.toString('utf8')).toBe('dotenv-value');
    });

    it('marks absent keys', () => {
      const paths = projectPaths(tmpDir);

      const presence = resolvePresence(paths, ['ABSENT_KEY']);
      const entry = presence.get('ABSENT_KEY');

      expect(entry).not.toBeUndefined();
      expect(entry?.present).toBe(false);
      expect(entry?.source).toBe('absent');
      expect(entry?.value).toBeNull();
    });

    it('prioritizes process.env over .env', () => {
      const paths = projectPaths(tmpDir);
      const originalValue = process.env['PRIORITY_TEST'] || '';

      try {
        writeFileSync(paths.dotenv, 'PRIORITY_TEST=dotenv-value\n', 'utf8');
        process.env['PRIORITY_TEST'] = 'process-value';

        const presence = resolvePresence(paths, ['PRIORITY_TEST']);
        const entry = presence.get('PRIORITY_TEST');

        expect(entry?.source).toBe('process-env');
        expect(entry?.value?.toString('utf8')).toBe('process-value');
      } finally {
        if (originalValue) {
          process.env['PRIORITY_TEST'] = originalValue;
        } else {
          delete process.env['PRIORITY_TEST'];
        }
      }
    });
  });
});
