import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { asSecret } from '@envseal/protocol';
import { SepError } from '@envseal/protocol';
import { runWithSecrets } from '../src/exec.js';

describe('exec', () => {
  describe('runWithSecrets', () => {
    it('redacts injected secrets from stdout', async () => {
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

    it('requires confirmation when onConfirm is not provided and command not approved', async () => {
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

    it('throws SEP_CONFIRMATION_DENIED when onConfirm returns false', async () => {
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

    it('detects network egress for curl', async () => {
      const confirmed = { value: false };
      const value = asSecret(Buffer.from('secret-value', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      try {
        await runWithSecrets(['curl', 'https://example.com'], secrets, {
          onConfirm: async (info) => {
            confirmed.value = info.networkEgress;
            return true;
          },
        });
      } catch {
        // curl might fail but we just care about the onConfirm call
      }

      expect(confirmed.value).toBe(true);
    });

    it('detects network egress for URL in arguments', async () => {
      const confirmed = { value: false };
      const value = asSecret(Buffer.from('secret-value', 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      try {
        await runWithSecrets(['wget', 'https://example.com'], secrets, {
          onConfirm: async (info) => {
            confirmed.value = info.networkEgress;
            return true;
          },
        });
      } catch {
        // wget might fail but we just care about the onConfirm call
      }

      expect(confirmed.value).toBe(true);
    });

    it('does not flag network egress for safe commands', async () => {
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

    it('handles timeout', async () => {
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
