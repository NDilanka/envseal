import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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

    // T11 hardening: consent binds to the target's content, not just its name.
    describe('target hashing (T11)', () => {
      it('surfaces target path and sha256 to onConfirm for a script target', { timeout: 30_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'envseal-exec-'));
        const script = join(dir, 'script.mjs');
        writeFileSync(script, "console.log('hi');\n", 'utf8');
        try {
          const value = asSecret(Buffer.from('secret-value', 'utf8'));
          const secrets = new Map([['TEST_KEY', value]]);
          const seen: { path: string; sha256: string | null }[] = [];

          const result = await runWithSecrets(['node', script], secrets, {
            onConfirm: async (info) => {
              seen.push({ path: info.target.resolvedPath, sha256: info.target.sha256 });
              return true;
            },
          });

          expect(result.exitCode).toBe(0);
          expect(seen).toHaveLength(1);
          // argv[0] ('node') resolves against the broker's own cwd (a PATH
          // lookup happens inside spawn), so it reports <cwd>/node, unhashed.
          expect(seen[0]!.path.toLowerCase()).toMatch(/[/\\]node$/);
          // argv[0] is PATH-resolved, so it stays unhashed...
          expect(seen[0]!.sha256).toBeNull();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('hashes a repo script passed as an argument, not just argv[0]', { timeout: 30_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'envseal-exec-'));
        const script = join(dir, 'script.mjs');
        writeFileSync(script, "console.log('hi');\n", 'utf8');
        try {
          const value = asSecret(Buffer.from('secret-value', 'utf8'));
          const secrets = new Map([['TEST_KEY', value]]);

          await runWithSecrets(['node', script], secrets, {
            onConfirm: async (info) => {
              // ...but the argument naming the script IS hashed and bound:
              // `node ./build/publish.mjs` must be approved by content.
              expect(info.target.hashedFiles).toHaveLength(1);
              expect(info.target.hashedFiles[0]!.resolvedPath.toLowerCase()).toBe(script.toLowerCase());
              expect(info.target.hashedFiles[0]!.sha256).toBe(
                createHash('sha256').update(Buffer.from("console.log('hi');\n", 'utf8')).digest('hex'),
              );
              return true;
            },
          });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('reports sha256 null when argv[0] does not name a readable file', { timeout: 30_000 }, async () => {
        const value = asSecret(Buffer.from('secret-value', 'utf8'));
        const secrets = new Map([['TEST_KEY', value]]);

        await runWithSecrets(
          process.platform === 'win32'
            ? ['powershell', '-c', '$env:TEST_KEY']
            : ['sh', '-c', 'echo $TEST_KEY'],
          secrets,
          {
            onConfirm: async (info) => {
              expect(info.target.sha256).toBeNull();
              return true;
            },
          },
        );
      });

      it('refuses with SEP_TARGET_CHANGED and runs nothing when content mutates between approval and spawn', { timeout: 30_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'envseal-exec-'));
        const script = join(dir, 'mutating.mjs');
        writeFileSync(script, "console.log('benign');\n", 'utf8');
        let mutations = 0;
        try {
          const value = asSecret(Buffer.from('secret-value', 'utf8'));
          const secrets = new Map([['TEST_KEY', value]]);

          await expect(
            runWithSecrets(['node', script], secrets, {
              onConfirm: async () => {
                // The injected-content attack: the file changes while the
                // approval dialog is open (or after it closes).
                appendFileSync(script, `// mutation ${mutations}\n`, 'utf8');
                mutations += 1;
                return true;
              },
            }),
          ).rejects.toMatchObject({ code: 'SEP_TARGET_CHANGED' });

          expect(mutations).toBe(1);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('re-prompts after SEP_TARGET_CHANGED instead of caching a refusal', { timeout: 30_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'envseal-exec-'));
        const script = join(dir, 'settling.mjs');
        writeFileSync(script, "console.log('v1');\n", 'utf8');
        try {
          const value = asSecret(Buffer.from('secret-value', 'utf8'));
          const secrets = new Map([['TEST_KEY', value]]);
          let calls = 0;

          await expect(
            runWithSecrets(['node', script], secrets, {
              onConfirm: async () => {
                calls += 1;
                if (calls === 1) {
                  // Content settles mid-flight: first attempt must refuse,
                  // and nothing may be remembered against this command.
                  writeFileSync(script, "console.log('v2');\n", 'utf8');
                  return true;
                }
                return true;
              },
            }),
          ).rejects.toMatchObject({ code: 'SEP_TARGET_CHANGED' });

          expect(calls).toBe(1);

          // Same command, second call: asked again from scratch, now stable,
          // so it runs.
          const result = await runWithSecrets(['node', script], secrets, {
            onConfirm: async () => {
              calls += 1;
              return true;
            },
          });
          expect(result.exitCode).toBe(0);
          expect(calls).toBe(2);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('skips revalidation entirely for approvedCommands (no consent happened)', { timeout: 30_000 }, async () => {
        const value = asSecret(Buffer.from('secret-api-key-12345', 'utf8'));
        const secrets = new Map([['TEST_KEY', value]]);
        const cmd =
          process.platform === 'win32' ? ['powershell', '-c', '$env:TEST_KEY'] : ['sh', '-c', 'echo $TEST_KEY'];

        const result = await runWithSecrets(cmd, secrets, { approvedCommands: [cmd.join(' ')] });
        expect(result.stdout).toContain('«redacted');
      });
    });
  });
});
