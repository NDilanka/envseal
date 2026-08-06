import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSecret, SepError } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import { getSink, allSinks } from '../src/sinks/registry.js';

describe('sinks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getSink', () => {
    it('returns dotenv sink', () => {
      const sink = getSink('dotenv');
      expect(sink.id).toBe('dotenv');
    });

    it('throws for unknown sink', () => {
      try {
        getSink('unknown');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err instanceof SepError).toBe(true);
        if (err instanceof SepError) {
          expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
        }
      }
    });
  });

  describe('allSinks', () => {
    it('includes dotenv and keychain', () => {
      const sinks = allSinks();
      const ids = sinks.map((s) => s.id);

      expect(ids).toContain('dotenv');
      expect(ids).toContain('keychain');
    });

    it('includes stubs for unimplemented sinks', () => {
      const sinks = allSinks();
      const ids = sinks.map((s) => s.id);

      expect(ids).toContain('sops');
      expect(ids).toContain('onepassword');
      expect(ids).toContain('doppler');
      expect(ids).toContain('vault');
    });
  });

  describe('unimplemented sinks', () => {
    it('sops has available false', async () => {
      const sink = getSink('sops');
      const available = await sink.available(projectPaths(tmpDir));
      expect(available).toBe(false);
    });

    it('onepassword write throws SEP_SINK_UNAVAILABLE', async () => {
      const sink = getSink('onepassword');
      const paths = projectPaths(tmpDir);
      const value = asSecret(Buffer.from('test', 'utf8'));

      try {
        await sink.write(paths, 'TEST', value);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err instanceof SepError).toBe(true);
        if (err instanceof SepError) {
          expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
        }
      }
    });

    it('doppler read throws SEP_SINK_UNAVAILABLE', async () => {
      const sink = getSink('doppler');
      const paths = projectPaths(tmpDir);

      try {
        await sink.read(paths, 'TEST');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err instanceof SepError).toBe(true);
        if (err instanceof SepError) {
          expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
        }
      }
    });

    it('vault remove throws SEP_SINK_UNAVAILABLE', async () => {
      const sink = getSink('vault');
      const paths = projectPaths(tmpDir);

      try {
        await sink.remove(paths, 'TEST');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err instanceof SepError).toBe(true);
        if (err instanceof SepError) {
          expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
        }
      }
    });
  });

  describe('dotenv sink', () => {
    it('writes and reads values', async () => {
      const sink = getSink('dotenv');
      const paths = projectPaths(tmpDir);
      const value = asSecret(Buffer.from('my-secret-value', 'utf8'));

      await sink.write(paths, 'TEST_KEY', value);

      const read = await sink.read(paths, 'TEST_KEY');
      expect(read).not.toBeNull();
      expect(read?.toString('utf8')).toBe('my-secret-value');
    });

    it('removes values', async () => {
      const sink = getSink('dotenv');
      const paths = projectPaths(tmpDir);
      const value = asSecret(Buffer.from('my-secret-value', 'utf8'));

      await sink.write(paths, 'TEST_KEY', value);
      const removed = await sink.remove(paths, 'TEST_KEY');

      expect(removed).toBe(true);

      const read = await sink.read(paths, 'TEST_KEY');
      expect(read).toBeNull();
    });

    it('is available', async () => {
      const sink = getSink('dotenv');
      const paths = projectPaths(tmpDir);
      const available = await sink.available(paths);
      expect(available).toBe(true);
    });
  });
});
