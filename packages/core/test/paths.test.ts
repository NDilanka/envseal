import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  projectPaths,
  findProjectRoot,
  ensureStateDir,
  loadOrCreateSalt,
} from '../src/paths.js';

describe('paths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('projectPaths', () => {
    it('returns absolute paths', () => {
      const paths = projectPaths(tmpDir);
      expect(paths.root).toBe(tmpDir);
      expect(paths.manifest).toBe(join(tmpDir, 'env.schema.jsonc'));
      expect(paths.dotenv).toBe(join(tmpDir, '.env'));
      expect(paths.stateDir).toBe(join(tmpDir, '.envseal'));
      expect(paths.salt).toBe(join(tmpDir, '.envseal', 'salt'));
      expect(paths.approvals).toBe(join(tmpDir, '.envseal', 'approvals.json'));
      expect(paths.audit).toBe(join(tmpDir, '.envseal', 'audit.jsonl'));
    });
  });

  describe('findProjectRoot', () => {
    it('finds env.schema.jsonc', () => {
      const fs = require('node:fs');
      fs.writeFileSync(join(tmpDir, 'env.schema.jsonc'), '{}');
      const result = findProjectRoot(tmpDir);
      expect(result).toBe(tmpDir);
    });

    it('finds .git', () => {
      const fs = require('node:fs');
      fs.mkdirSync(join(tmpDir, '.git'));
      const result = findProjectRoot(tmpDir);
      expect(result).toBe(tmpDir);
    });

    it('finds package.json', () => {
      const fs = require('node:fs');
      fs.writeFileSync(join(tmpDir, 'package.json'), '{}');
      const result = findProjectRoot(tmpDir);
      expect(result).toBe(tmpDir);
    });

    it('returns startDir if nothing found', () => {
      const result = findProjectRoot(tmpDir);
      expect(result).toBe(tmpDir);
    });
  });

  describe('ensureStateDir', () => {
    it('creates .envseal directory', () => {
      const paths = projectPaths(tmpDir);
      ensureStateDir(paths);
      const fs = require('node:fs');
      expect(fs.existsSync(paths.stateDir)).toBe(true);
    });
  });

  describe('loadOrCreateSalt', () => {
    it('creates 32-byte salt', () => {
      const paths = projectPaths(tmpDir);
      const salt = loadOrCreateSalt(paths);
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(32);
    });

    it('returns same salt on second call', () => {
      const paths = projectPaths(tmpDir);
      const salt1 = loadOrCreateSalt(paths);
      const salt2 = loadOrCreateSalt(paths);
      expect(salt1).toEqual(salt2);
    });
  });
});
