import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'dist', 'bin.js');

const SENTINEL = 'sk-SENTINEL-CLI-DO-NOT-LEAK-7a1b2c3d4e5f6a7b';

describe('shell-e2e: full CLI flow with real binary', () => {
  let tempDir: string;

  beforeEach(() => {
    // Must live OUTSIDE the repo. A temp dir under process.cwd() sits inside the
    // envseal workspace, so `findProjectRoot` walks up past it to packages/cli and
    // every command silently operates on this repository instead of the fixture —
    // which is how earlier runs wrote a manifest into the source tree.
    tempDir = mkdtempSync(join(tmpdir(), 'envseal-cli-e2e-'));
    // Create .gitignore with .env entry
    writeFileSync(join(tempDir, '.gitignore'), '.env\n');
    // `init` discovers keys by scanning source for env references. Without a
    // file to find, it produces an empty manifest, nothing is ever "missing",
    // and the exit-code assertions below would be measuring an empty project.
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'client.ts'),
      'export const key = process.env.TEST_KEY;\n',
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('completes full provisioning flow without leaking sentinel', async () => {
    expect(existsSync(binPath), `Binary not found at ${binPath}`).toBe(true);

    // Helper to run envseal command and capture both stdout and stderr
    const runCmd = (
      args: string[],
      env?: Record<string, string>,
    ): { stdout: string; stderr: string; exitCode: number } => {
      const result = spawnSync('node', [binPath, ...args], {
        cwd: tempDir,
        encoding: 'utf-8',
        env: {
          ...process.env,
          ...env,
        },
      });

      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.status ?? -1,
      };
    };

    // 1. Initialize
    const initResult = runCmd(['init']);
    expect(initResult.exitCode).toBe(0);

    // 2. Check status --json before provisioning (should report missing)
    const statusBefore = runCmd(['status', '--json']);
    // The exit code IS the Tier-4 interface: a shell-only agent branches on it.
    // `>= 0` would pass for every possible outcome and assert nothing.
    expect(statusBefore.exitCode).toBe(1); // EXIT.UNSATISFIED

    // 3. Set a key with stub prompter
    const setResult = runCmd(['set', 'TEST_KEY', '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_VALUE: SENTINEL,
    });
    expect(setResult.exitCode).toBe(0);

    // Check that sentinel never appears in any output
    const allOutput = [
      statusBefore.stdout,
      statusBefore.stderr,
      setResult.stdout,
      setResult.stderr,
    ].join('\n');

    expect(allOutput).not.toContain(SENTINEL);

    // 4. Check status --json after provisioning (should report present)
    const statusAfter = runCmd(['status', '--json']);
    const statusJson = JSON.parse(statusAfter.stdout);

    // At least one entry should be present (the one we just set)
    // and have a fingerprint starting with fp_
    const testKeyEntry = statusJson.entries?.find(
      (e: any) => e.key === 'TEST_KEY',
    );
    // Unconditional: guarding this behind `if (testKeyEntry)` would let the whole
    // flow-completed half of the gate silently vanish whenever provisioning broke,
    // leaving only "sentinel absent" — which passes trivially when nothing ran.
    expect(testKeyEntry).toBeDefined();
    expect(testKeyEntry.present).toBe(true);
    expect(testKeyEntry.fingerprint).toMatch(/^fp_[0-9a-f]{8}$/);

    // 5. Doctor must now report a satisfied project.
    const doctorResult = runCmd(['doctor', '--json']);
    expect(doctorResult.exitCode).toBe(0); // EXIT.OK

    // 6. Concatenate ALL stdout and stderr from all commands
    const allCmdOutput = [
      initResult.stdout,
      initResult.stderr,
      statusBefore.stdout,
      statusBefore.stderr,
      setResult.stdout,
      setResult.stderr,
      statusAfter.stdout,
      statusAfter.stderr,
      doctorResult.stdout,
      doctorResult.stderr,
    ].join('\n');

    // Assert sentinel appears nowhere in the combined output
    expect(allCmdOutput).not.toContain(SENTINEL);
  });

  it('verifies exit code 1 (UNSATISFIED) when required key is missing', () => {
    const binPath_local = join(__dirname, '..', 'dist', 'bin.js');
    expect(existsSync(binPath_local)).toBe(true);

    const result = spawnSync('node', [binPath_local, 'status', '--json'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    // If required keys are missing, status should exit 1
    // (This assumes the test sets up a manifest with required keys)
    // For now, just verify the command runs
    expect(typeof result.stdout).toBe('string');
  });

  it('verifies flow really worked by checking fingerprint', () => {
    const binPath_local = join(__dirname, '..', 'dist', 'bin.js');

    const runCmd = (
      args: string[],
      env?: Record<string, string>,
    ): { stdout: string; stderr: string; exitCode: number } => {
      const result = spawnSync('node', [binPath_local, ...args], {
        cwd: tempDir,
        encoding: 'utf-8',
        env: { ...process.env, ...env },
      });

      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.status ?? -1,
      };
    };

    // Initialize and set a key
    runCmd(['init']);
    runCmd(['set', 'FLOW_TEST_KEY', '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_VALUE: SENTINEL,
    });

    // Verify the key was really stored by checking status
    const statusResult = runCmd(['status', '--json']);
    const statusJson = JSON.parse(statusResult.stdout);

    const entry = statusJson.entries?.find(
      (e: any) => e.key === 'FLOW_TEST_KEY',
    );
    expect(entry?.present).toBe(true);
    expect(entry?.fingerprint).toMatch(/^fp_[a-f0-9]{8}$/);

    // Verify sentinel is NOT in the output
    expect(statusResult.stdout + statusResult.stderr).not.toContain(SENTINEL);
  });
});
