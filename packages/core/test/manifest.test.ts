import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectPaths, loadOrCreateSalt } from '../src/paths.js';
import { loadManifest, saveManifest, declareEntries, emptyManifest } from '../src/manifest.js';
import { SepError } from '@envseal/protocol';

describe('manifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadManifest', () => {
    it('returns null if file does not exist', () => {
      const paths = projectPaths(tmpDir);
      const result = loadManifest(paths);
      expect(result).toBeNull();
    });

    it('loads valid manifest', () => {
      const paths = projectPaths(tmpDir);
      const manifest = {
        version: 1 as const,
        entries: [
          {
            key: 'TEST_KEY',
            description: 'A test key',
          },
        ],
      };
      saveManifest(paths, manifest);
      const loaded = loadManifest(paths);
      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe(1);
      expect(loaded?.entries).toHaveLength(1);
      expect(loaded?.entries?.[0]?.key).toBe('TEST_KEY');
    });
  });

  describe('saveManifest', () => {
    it('renders a fresh manifest without a dead $schema pointer', () => {
      // "./spec/sep-1/manifest.schema.json" only resolves inside this repo; in
      // a user project editors flagged it as a dangling reference.
      const paths = projectPaths(tmpDir);
      saveManifest(paths, emptyManifest());
      const saved = readFileSync(paths.manifest, 'utf8');

      expect(saved).not.toContain('"$schema"');
      expect(saved).toContain('// JSON Schema: spec/sep-1/manifest.schema.json in the envseal repo');
    });

    it('preserves an existing $schema field across an update', () => {
      const paths = projectPaths(tmpDir);
      writeFileSync(
        paths.manifest,
        '{\n  "$schema": "https://example.test/manifest.schema.json",\n  "version": 1,\n  "entries": []\n}\n',
        'utf8',
      );

      declareEntries(paths, [{ key: 'NEW_KEY', description: 'New key' }]);
      const saved = readFileSync(paths.manifest, 'utf8');

      expect(saved).toContain('"$schema": "https://example.test/manifest.schema.json"');
      expect(saved).toContain('NEW_KEY');
      const reloaded = loadManifest(paths);
      expect(reloaded?.entries).toHaveLength(1);
    });

    it('preserves comments on update', () => {
      const paths = projectPaths(tmpDir);
      const manifestWithComments = `// This is a leading comment
/* Block comment */
{
  "version": 1,
  "entries": []
}
`;
      writeFileSync(paths.manifest, manifestWithComments, 'utf8');
      const manifest = loadManifest(paths);
      expect(manifest).not.toBeNull();

      const newManifest = {
        version: 1 as const,
        entries: [
          {
            key: 'NEW_KEY',
            description: 'New key',
          },
        ],
      };

      saveManifest(paths, newManifest);
      const saved = readFileSync(paths.manifest, 'utf8');

      expect(saved).toContain('// This is a leading comment');
      expect(saved).toContain('/* Block comment */');
      expect(saved).toContain('NEW_KEY');
    });
  });

  describe('declareEntries', () => {
    it('rejects entry with value field', () => {
      const paths = projectPaths(tmpDir);
      const entries = [
        {
          key: 'BAD_KEY',
          description: 'This has a value',
          value: 'secret123',
        },
      ];

      expect(() => declareEntries(paths, entries)).toThrow(SepError);
      try {
        declareEntries(paths, entries);
      } catch (error) {
        if (error instanceof SepError) {
          expect(error.code).toBe('SEP_VALUE_IN_REQUEST');
        }
      }
    });

    it('adds new entries', () => {
      const paths = projectPaths(tmpDir);
      const result = declareEntries(paths, [
        {
          key: 'TEST_KEY',
          description: 'A test key',
        },
      ]);

      expect(result.added).toContain('TEST_KEY');
      expect(result.unchanged).toHaveLength(0);
      expect(result.updated).toHaveLength(0);

      const loaded = loadManifest(paths);
      expect(loaded?.entries).toHaveLength(1);
    });

    it('marks unchanged entries', () => {
      const paths = projectPaths(tmpDir);
      const entry = {
        key: 'TEST_KEY',
        description: 'A test key',
      };

      declareEntries(paths, [entry]);
      const result = declareEntries(paths, [entry]);

      expect(result.unchanged).toContain('TEST_KEY');
      expect(result.added).toHaveLength(0);
      expect(result.updated).toHaveLength(0);
    });

    it('marks updated entries', () => {
      const paths = projectPaths(tmpDir);
      declareEntries(paths, [
        {
          key: 'TEST_KEY',
          description: 'Original description',
        },
      ]);

      const result = declareEntries(paths, [
        {
          key: 'TEST_KEY',
          description: 'Updated description',
        },
      ]);

      expect(result.updated).toContain('TEST_KEY');
      expect(result.added).toHaveLength(0);
    });
  });

  describe('emptyManifest', () => {
    it('returns empty manifest', () => {
      const manifest = emptyManifest();
      expect(manifest.version).toBe(1);
      expect(manifest.entries).toHaveLength(0);
    });
  });
});
