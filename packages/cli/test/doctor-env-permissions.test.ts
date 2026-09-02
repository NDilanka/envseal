/**
 * doctor's .env permissions check must not lie on Windows.
 *
 * Node statSync on Windows reports a nominal POSIX mode (0o666 writable), so
 * the group/other-bits test produced 0o066 ≠ 0 and permissionsOk:false on
 * every Windows machine regardless of the real ACLs. The fix reports null
 * ("not measurable here") on win32; POSIX keeps the boolean. This pins the
 * honest shape on whatever platform runs the test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'dist', 'bin.js');
const WATCHDOG_MS = 20_000;

interface DoctorEnvFile {
  exists: boolean;
  isTracked: boolean;
  permissionsOk: boolean | null;
}

function runDoctorJson(cwd: string): { exitCode: number; stdout: string } {
  const result = spawnSync(process.execPath, [binPath, 'doctor', '--json'], {
    cwd,
    encoding: 'utf-8',
    timeout: WATCHDOG_MS,
    input: '',
  });
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? '' };
}

describe('doctor envFile.permissionsOk honesty', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'envseal-doctor-perms-'));
    writeFileSync(join(tempDir, '.gitignore'), '.env\n');
    writeFileSync(join(tempDir, 'AGENTS.md'), 'This repository uses envseal. Never read .env. Use envseal ensure and envseal run -- instead.\n');
    writeFileSync(
      join(tempDir, 'env.schema.jsonc'),
      JSON.stringify(
        { version: 1, entries: [{ key: 'PERM_KEY', description: 'd', required: false, secret: true, sink: 'dotenv' }] },
        null,
        2,
      ),
    );
    writeFileSync(join(tempDir, '.env'), 'PERM_KEY=sk-doctor-perms-value-1234567890\n');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports null on Windows and a real boolean on POSIX', () => {
    const run = runDoctorJson(tempDir);
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as { envFile: DoctorEnvFile };
    expect(parsed.envFile.exists).toBe(true);

    if (process.platform === 'win32') {
      expect(parsed.envFile.permissionsOk).toBeNull();
    } else {
      expect(typeof parsed.envFile.permissionsOk).toBe('boolean');
      expect(parsed.envFile.permissionsOk).toBe(true);
    }
  });
});
