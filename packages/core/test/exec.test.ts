import { describe, it, expect } from 'vitest';
import { asSecret } from '@envseal/protocol';
import { SepError } from '@envseal/protocol';
import { runWithSecrets } from '../src/exec.js';

describe('exec', () => {
  describe('runWithSecrets', () => {
    // Every test spawns a child process (powershell/sh, curl). Cold CI
    // runners outran the 5s vitest default twice before this landed; same
    // treatment as the keychain/presence/native suites.
    it('redacts injected secrets from stdout', { timeout: 30_000 }, async () => {
      const value = asSecret(Buffer.from('secret-api-key-12345', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      const result = await runWithSecrets(
        process.platform === 'win32' ? ['powershell', '-c', '$env:TEST_KEY'] : ['sh', '-c', 'echo $TEST_KEY'],
        secrets,
        {
          approvedCommands: [
            (process.platform === 'win32' ? ['powershell', '-c', '$env:TEST_KEY'] : ['sh', '-c', 'echo $TEST_KEY']).join(' '),
          ],
        },
      );

      expect(result.stdout).toContain('«redacted');
      expect(result.stdout).not.toContain('secret-api-key-12345');
    });

    it('requires confirmation when onConfirm is not provided and command not approved', { timeout: 30_000 }, async () => {
      const value = asSecret(Buffer.from('secret-value', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      try {
        await runWithSecrets(['echo', 'hello'], secrets, {
          approvedCommands: [],
        });
        expect.fail('Should have thrown SEP_CONFIRMATION_DENIED');
      } catch (err) {
        if (!(err instanceof SepError)) {
          throw err;
        }
        expect(err.code).toBe('SEP_CONFIRMATION_DENIED');
      }
    });

    it('throws SEP_CONFIRMATION_DENIED when onConfirm returns false', { timeout: 30_000 }, async () => {
      const value = asSecret(Buffer.from('secret-value', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      try {
        await runWithSecrets(['echo', 'hello'], secrets, {
          onConfirm: async () => false,
        });
        expect.fail('Should have thrown SEP_CONFIRMATION_DENIED');
      } catch (err) {
        if (!(err instanceof SepError)) {
          throw err;
        }
        expect(err.code).toBe('SEP_CONFIRMATION_DENIED');
      }
    });

    it('detects network egress for curl', { timeout: 30_000 }, async () => {
      const confirmed = { value: false };
      const value = asSecret(Buffer.from('secret-value', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      try {
        // .invalid is guaranteed unresolvable (RFC 2606): the egress flag comes
        // from inspecting the command's arguments, not from the transfer
        // succeeding, so no real network request is needed. A real URL here
        // made Linux CI download https://example.com into packages/core as
        // index.html (wget/curl default output), dirtying the tree and
        // aborting the release publish leg.
        await runWithSecrets(['curl', 'https://envseal-egress.invalid/'], secrets, {
          onConfirm: async (info) => {
            confirmed.value = info.networkEgress;
            return true;
          },
        });
      } catch {
        // the transfer failing is fine; we just care about the onConfirm call
      }

      expect(confirmed.value).toBe(true);
    });

    it('detects network egress for URL in arguments', { timeout: 30_000 }, async () => {
      const confirmed = { value: false };
      const value = asSecret(Buffer.from('secret-value', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      try {
        // See the curl case above: .invalid keeps this hermetic. The old real
        // URL caused wget to write ./index.html into the repo on Linux CI.
        await runWithSecrets(['wget', 'https://envseal-egress.invalid/'], secrets, {
          onConfirm: async (info) => {
            confirmed.value = info.networkEgress;
            return true;
          },
        });
      } catch {
        // the transfer failing is fine; we just care about the onConfirm call
      }

      expect(confirmed.value).toBe(true);
    });

    it('does not flag network egress for safe commands', { timeout: 30_000 }, async () => {
      const confirmed = { value: true };
      const value = asSecret(Buffer.from('secret-value', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      try {
        await runWithSecrets(['echo', 'hello'], secrets, {
          onConfirm: async (info) => {
            confirmed.value = info.networkEgress;
            return true;
          },
        });
      } catch {
        // echo shouldn't error
      }

      expect(confirmed.value).toBe(false);
    });

    it('handles timeout', { timeout: 30_000 }, async () => {
      const value = asSecret(Buffer.from('secret-value', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      const result = await runWithSecrets(
        process.platform === 'win32' ? ['powershell', '-c', 'Start-Sleep -Seconds 10'] : ['sleep', '10'],
        secrets,
        {
          timeoutMs: 500,
          onConfirm: async () => true,
        },
      );

      expect(result.timedOut).toBe(true);
    });
  });
});
