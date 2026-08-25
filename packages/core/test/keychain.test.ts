import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { asSecret } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import { keychainSink, buildDarwinWriteArgs } from '../src/sinks/keychain.js';

// Unique per run: the Windows blob is keyed by <KEY> alone in the shared
// per-user creds dir (that is how write() stores it), so a fixed name would
// collide with concurrent test runs or leave state behind a failed suite.
const KEY = `ENVSEAL_TEST_KC_${randomBytes(6).toString('hex').toUpperCase()}`;
// ASCII with punctuation AND non-ASCII: the Windows pipes carry a hex
// transport (see WIN_HEX_PREFIX in keychain.ts) so both must come back
// byte-exact regardless of the console's OEM codepage.
const VALUE = 'sk-test-Kc7#pQz!9Rd-_2Wx/4Yv+6Zt=8Nb';
const UNICODE_VALUE = 'ünïcödé-🔐-日本語-✓-sk-test';

function windowsCredsDir(): string {
  return join(homedir(), 'AppData', 'Local', 'envseal', 'creds');
}

function commandAvailable(cmd: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(checker, [cmd], { stdio: 'ignore' }).status === 0;
}

describe('keychain sink round-trip', () => {
  it('darwin write args never include the secret or -w', () => {
    const secret = 'sk-test-never-on-argv-abc123';
    const args = buildDarwinWriteArgs('myproject:MY_KEY');
    expect(args).not.toContain('-w');
    expect(args.join(' ')).not.toContain(secret);
    expect(args).toEqual(['add-generic-password', '-U', '-s', 'envseal', '-a', 'myproject:MY_KEY']);
  });

  // Every test spawns the platform store helper several times (powershell/
  // DPAPI on Windows, security on macOS, secret-tool on Linux). Cold CI
  // runners outran the 5s vitest default on first exposure — passing on dev
  // machines with warm caches — so each carries explicit headroom.
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
    it('write then read round-trips the value', { timeout: 30_000 }, async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
      const read = await keychainSink.read(paths, KEY);
      expect(read).not.toBeNull();
      expect(read?.toString('utf8')).toBe(VALUE);
    });

    // The pipe transport is hex of UTF-8 bytes precisely so the console's OEM
    // codepage cannot mojibake these before DPAPI ever sees them.
    it('non-ASCII values round-trip byte-exact', { timeout: 30_000 }, async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(UNICODE_VALUE, 'utf8')));
      const read = await keychainSink.read(paths, KEY);
      expect(read?.toString('utf8')).toBe(UNICODE_VALUE);
    });

    // Blobs written by the pre-hex code hold the raw plaintext (ASCII in
    // practice). read() must keep returning those verbatim, not attempt a
    // hex decode of e.g. 'sk-legacy-...' and corrupt it.
    it('legacy pre-hex blobs read back verbatim', { timeout: 30_000 }, async () => {
      const legacy = 'sk-legacy-ASCII-value-42';
      const dir = windowsCredsDir();
      mkdirSync(dir, { recursive: true });
      const blobPath = join(dir, KEY).replace(/\\/g, '\\\\');
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$secure = ConvertTo-SecureString -String '${legacy}' -AsPlainText -Force`,
        `$encrypted = ConvertFrom-SecureString -SecureString $secure`,
        `[System.IO.File]::WriteAllText('${blobPath}', $encrypted)`,
      ].join('\n');
      const scriptPath = join(dir, `${KEY}.legacy.ps1`);
      writeFileSync(scriptPath, script);
      // Same PSModulePath scrub the sink applies: an editor-exported PS 7
      // module path breaks the Security module under PowerShell 5.1.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (/^psmodulepath$/i.test(k) || v === undefined) continue;
        env[k] = v;
      }
      try {
        const r = spawnSync('powershell', ['-NoProfile', '-File', scriptPath], {
          encoding: 'utf8',
          env,
        });
        expect(r.status, r.stderr?.toString()).toBe(0);
        const read = await keychainSink.read(paths, KEY);
        expect(read?.toString('utf8')).toBe(legacy);
      } finally {
        try {
          unlinkSync(scriptPath);
        } catch {
          // ignore
        }
      }
    });

    it('read on an absent key returns null', { timeout: 30_000 }, async () => {
      const read = await keychainSink.read(paths, KEY);
      expect(read).toBeNull();
    });

    it('remove deletes the blob, then read returns null and remove reports false', { timeout: 30_000 }, async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
      expect(await keychainSink.remove(paths, KEY)).toBe(true);
      expect(await keychainSink.read(paths, KEY)).toBeNull();
      expect(await keychainSink.remove(paths, KEY)).toBe(false);
    });

    it('read throws on a corrupt (non-hex) blob instead of pretending absence', { timeout: 30_000 }, async () => {
      mkdirSync(windowsCredsDir(), { recursive: true });
      writeFileSync(join(windowsCredsDir(), KEY), 'not-a-hex-dpapi-blob', 'utf8');
      await expect(keychainSink.read(paths, KEY)).rejects.toThrow(/not a hex DPAPI blob/);
    });

    it('read throws on an empty blob instead of pretending absence', { timeout: 30_000 }, async () => {
      mkdirSync(windowsCredsDir(), { recursive: true });
      writeFileSync(join(windowsCredsDir(), KEY), '', 'utf8');
      await expect(keychainSink.read(paths, KEY)).rejects.toThrow(/is empty/);
    });
  });

  describe.skipIf(process.platform !== 'darwin' || !commandAvailable('security'))(
    'macOS security',
    () => {
      it('write then read round-trips the value', { timeout: 30_000 }, async () => {
        await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
        const read = await keychainSink.read(paths, KEY);
        expect(read?.toString('utf8')).toBe(VALUE);
      });

      it('read on an absent key returns null', { timeout: 30_000 }, async () => {
        expect(await keychainSink.read(paths, KEY)).toBeNull();
      });

      it('remove deletes the entry, then read returns null and remove reports false', { timeout: 30_000 }, async () => {
        await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
        expect(await keychainSink.remove(paths, KEY)).toBe(true);
        expect(await keychainSink.read(paths, KEY)).toBeNull();
        expect(await keychainSink.remove(paths, KEY)).toBe(false);
      });
    },
  );

  const linuxReady = process.platform === 'linux' && commandAvailable('secret-tool');
  describe.skipIf(!linuxReady)('Linux secret-tool', () => {
    it('write then read round-trips the value', { timeout: 30_000 }, async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
      const read = await keychainSink.read(paths, KEY);
      expect(read?.toString('utf8')).toBe(VALUE);
    });

    it('read on an absent key returns null', { timeout: 30_000 }, async () => {
      expect(await keychainSink.read(paths, KEY)).toBeNull();
    });

    it('remove deletes the entry, then read returns null and remove reports false', { timeout: 30_000 }, async () => {
      await keychainSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
      expect(await keychainSink.remove(paths, KEY)).toBe(true);
      expect(await keychainSink.read(paths, KEY)).toBeNull();
      expect(await keychainSink.remove(paths, KEY)).toBe(false);
    });
  });
});
