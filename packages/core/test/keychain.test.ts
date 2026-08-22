import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { asSecret } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import { keychainSink } from '../src/sinks/keychain.js';

// Unique per run: the Windows blob is keyed by <KEY> alone in the shared
// per-user creds dir (that is how write() stores it), so a fixed name would
// collide with concurrent test runs or leave state behind a failed suite.
const KEY = `ENVSEAL_TEST_KC_${randomBytes(6).toString('hex').toUpperCase()}`;
// ASCII with punctuation: everything the PowerShell stdin/stdout pipes carry
// byte-exact (see the platform caveat in keychain.ts).
const VALUE = 'sk-test-Kc7#pQz!9Rd-_2Wx/4Yv+6Zt=8Nb';

function windowsCredsDir(): string {
  return join(homedir(), 'AppData', 'Local', 'envseal', 'creds');
}

function commandAvailable(cmd: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(checker, [cmd], { stdio: 'ignore' }).status === 0;
}

describe('keychain sink round-trip', () => {
  let tmpDir: string;
  let paths: ReturnType<typeof projectPaths>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-kc-'));
    paths = projectPaths(tmpDir);
  });

  afterEach(async () => {
    // Best-effort cleanup of the shared store; remove() is a no-op (false)
    // when the test already deleted the entry.
    try {
      await keychainSink.remove(paths, KEY);
    } catch {
      // ignore — cleanup must never mask a test failure
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe.skipIf(process.platform !== 'win32')('Windows DPAPI blob', () => {
    it('write then read round-trips the value', async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
      const read = await keychainSink.read(paths, KEY);
      expect(read).not.toBeNull();
      expect(read?.toString('utf8')).toBe(VALUE);
    });

    it('read on an absent key returns null', async () => {
      const read = await keychainSink.read(paths, KEY);
      expect(read).toBeNull();
    });

    it('remove deletes the blob, then read returns null and remove reports false', async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
      expect(await keychainSink.remove(paths, KEY)).toBe(true);
      expect(await keychainSink.read(paths, KEY)).toBeNull();
      expect(await keychainSink.remove(paths, KEY)).toBe(false);
    });

    it('read throws on a corrupt (non-hex) blob instead of pretending absence', async () => {
      mkdirSync(windowsCredsDir(), { recursive: true });
      writeFileSync(join(windowsCredsDir(), KEY), 'not-a-hex-dpapi-blob', 'utf8');
      await expect(keychainSink.read(paths, KEY)).rejects.toThrow(/not a hex DPAPI blob/);
    });

    it('read throws on an empty blob instead of pretending absence', async () => {
      mkdirSync(windowsCredsDir(), { recursive: true });
      writeFileSync(join(windowsCredsDir(), KEY), '', 'utf8');
      await expect(keychainSink.read(paths, KEY)).rejects.toThrow(/is empty/);
    });
  });

  describe.skipIf(process.platform !== 'darwin' || !commandAvailable('security'))(
    'macOS security',
    () => {
      it('write then read round-trips the value', async () => {
        await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
        const read = await keychainSink.read(paths, KEY);
        expect(read?.toString('utf8')).toBe(VALUE);
      });

      it('read on an absent key returns null', async () => {
        expect(await keychainSink.read(paths, KEY)).toBeNull();
      });

      it('remove deletes the entry, then read returns null and remove reports false', async () => {
        await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
        expect(await keychainSink.remove(paths, KEY)).toBe(true);
        expect(await keychainSink.read(paths, KEY)).toBeNull();
        expect(await keychainSink.remove(paths, KEY)).toBe(false);
      });
    },
  );

  const linuxReady = process.platform === 'linux' && commandAvailable('secret-tool');
  describe.skipIf(!linuxReady)('Linux secret-tool', () => {
    it('write then read round-trips the value', async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
      const read = await keychainSink.read(paths, KEY);
      expect(read?.toString('utf8')).toBe(VALUE);
    });

    it('read on an absent key returns null', async () => {
      expect(await keychainSink.read(paths, KEY)).toBeNull();
    });

    it('remove deletes the entry, then read returns null and remove reports false', async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
      expect(await keychainSink.remove(paths, KEY)).toBe(true);
      expect(await keychainSink.read(paths, KEY)).toBeNull();
      expect(await keychainSink.remove(paths, KEY)).toBe(false);
    });
  });
});
