import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { asSecret } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import { resolvePresence } from '../src/presence.js';
import { keychainSink } from '../src/sinks/keychain.js';
import { Broker } from '../src/broker.js';

describe('presence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolvePresence', () => {
    it('does not mutate process.env', async () => {
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
      await resolvePresence(paths, ['TEST_KEY_1', 'TEST_KEY_2']);

      // Verify process.env is unchanged
      expect(process.env).toEqual(before);
    });

    it('finds values in process.env', async () => {
      const paths = projectPaths(tmpDir);
      const originalValue = process.env['ENVSEAL_TEST_KEY_123'] || '';

      try {
        process.env['ENVSEAL_TEST_KEY_123'] = 'process-value';

        const presence = await resolvePresence(paths, ['ENVSEAL_TEST_KEY_123']);
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

    it('finds values in .env file', async () => {
      const paths = projectPaths(tmpDir);
      writeFileSync(paths.dotenv, 'DOTENV_KEY=dotenv-value\n', 'utf8');

      const presence = await resolvePresence(paths, ['DOTENV_KEY']);
      const entry = presence.get('DOTENV_KEY');

      expect(entry).not.toBeUndefined();
      expect(entry?.present).toBe(true);
      expect(entry?.source).toBe('dotenv');
      expect(entry?.value?.toString('utf8')).toBe('dotenv-value');
    });

    it('marks absent keys', async () => {
      const paths = projectPaths(tmpDir);

      const presence = await resolvePresence(paths, ['ABSENT_KEY']);
      const entry = presence.get('ABSENT_KEY');

      expect(entry).not.toBeUndefined();
      expect(entry?.present).toBe(false);
      expect(entry?.source).toBe('absent');
      expect(entry?.value).toBeNull();
    });

    it('prioritizes process.env over .env', async () => {
      const paths = projectPaths(tmpDir);
      const originalValue = process.env['PRIORITY_TEST'] || '';

      try {
        writeFileSync(paths.dotenv, 'PRIORITY_TEST=dotenv-value\n', 'utf8');
        process.env['PRIORITY_TEST'] = 'process-value';

        const presence = await resolvePresence(paths, ['PRIORITY_TEST']);
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

  // The Windows DPAPI path runs unconditionally on this platform; mac/linux
  // CI stores differ, so those legs live in keychain.test.ts behind their own
  // guards.
  const winReady = process.platform === 'win32';
  const KC_KEY = `ENVSEAL_TEST_PRESENCE_${randomBytes(6).toString('hex').toUpperCase()}`;
  const KC_VALUE = 'sk-test-presence-RoundTrip9xQ';
  const sinksOf = (...keys: string[]) => new Map(keys.map((k) => [k, 'keychain']));

  // Every test here spawns powershell several times (DPAPI encrypt/decrypt per
  // operation). A cold windows runner outran the 5s vitest default on the
  // project's first CI exposure — passing on dev machines with warm caches —
  // so these carry explicit headroom rather than relying on runner warmth.
  describe.skipIf(!winReady)('sink-aware resolution (Windows keychain)', () => {
    let paths: ReturnType<typeof projectPaths>;

    beforeEach(() => {
      paths = projectPaths(tmpDir);
    });

    afterEach(async () => {
      try {
        await keychainSink.remove(paths, KC_KEY);
      } catch {
        // ignore — cleanup must never mask a test failure
      }
    });

    it('reports a stored keychain credential as present via the sink', { timeout: 30_000 }, async () => {
      await keychainSink.write(paths, KC_KEY, asSecret(Buffer.from(KC_VALUE, 'utf8')));

      const presence = await resolvePresence(paths, [KC_KEY], { sinks: sinksOf(KC_KEY) });
      const entry = presence.get(KC_KEY);

      expect(entry?.present).toBe(true);
      expect(entry?.source).toBe('sink');
      expect(entry?.value?.toString('utf8')).toBe(KC_VALUE);
    });

    it('reports absent after the credential is removed', { timeout: 30_000 }, async () => {
      await keychainSink.write(paths, KC_KEY, asSecret(Buffer.from(KC_VALUE, 'utf8')));
      await keychainSink.remove(paths, KC_KEY);

      const presence = await resolvePresence(paths, [KC_KEY], { sinks: sinksOf(KC_KEY) });
      const entry = presence.get(KC_KEY);

      expect(entry?.present).toBe(false);
      expect(entry?.source).toBe('absent');
      expect(entry?.value).toBeNull();
    });

    it('does not fall back to .env for a keychain-declared key', { timeout: 30_000 }, async () => {
      // A keychain-declared key is only resolvable through its declared sink,
      // so a hand-written .env line must not make status claim present.
      writeFileSync(paths.dotenv, `${KC_KEY}=from-dotenv\n`, 'utf8');

      const presence = await resolvePresence(paths, [KC_KEY], { sinks: sinksOf(KC_KEY) });
      expect(presence.get(KC_KEY)?.present).toBe(false);
    });

    it('keeps process.env precedence over the sink', { timeout: 30_000 }, async () => {
      await keychainSink.write(paths, KC_KEY, asSecret(Buffer.from(KC_VALUE, 'utf8')));
      try {
        process.env[KC_KEY] = 'from-process-env';
        const presence = await resolvePresence(paths, [KC_KEY], { sinks: sinksOf(KC_KEY) });
        expect(presence.get(KC_KEY)?.source).toBe('process-env');
      } finally {
        delete process.env[KC_KEY];
      }
    });

    it('degrades to absent when the sink read throws', { timeout: 30_000 }, async () => {
      // Corrupt blob makes read() throw; presence must not propagate it —
      // describe/status answer even when the store is unhappy.
      const credsDir = join(homedir(), 'AppData', 'Local', 'envseal', 'creds');
      mkdirSync(credsDir, { recursive: true });
      writeFileSync(join(credsDir, KC_KEY), 'garbage-not-hex', 'utf8');

      const presence = await resolvePresence(paths, [KC_KEY], { sinks: sinksOf(KC_KEY) });
      expect(presence.get(KC_KEY)?.present).toBe(false);
    });

    it('Broker.describe sees the stored credential and revoke clears it', { timeout: 30_000 }, async () => {
      const broker = new Broker({ root: tmpDir });
      try {
        await broker.declare({
          entries: [{ key: KC_KEY, required: true, description: 'presence test', sink: 'keychain' }],
        });
        await keychainSink.write(paths, KC_KEY, asSecret(Buffer.from(KC_VALUE, 'utf8')));

        const before = await broker.describe();
        const entryBefore = before.entries.find((e) => e.key === KC_KEY);
        expect(entryBefore?.sink).toBe('keychain');
        expect(entryBefore?.present).toBe(true);
        expect(before.missingRequired).not.toContain(KC_KEY);

        const revoked = await broker.revoke({ keys: [KC_KEY] });
        expect(revoked[0]?.removed).toBe(true);

        const after = await broker.describe();
        expect(after.entries.find((e) => e.key === KC_KEY)?.present).toBe(false);
        expect(after.missingRequired).toContain(KC_KEY);
      } finally {
        broker.dispose();
      }
    });
  });
});
