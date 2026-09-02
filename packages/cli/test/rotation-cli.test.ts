/**
 * Rotation surfacing through the shipped CLI (doctor + status).
 *
 * The manifest's rotation.maxAgeDays knob and KeyStatus.rotationDue existed in
 * the schema without any producer. This pins the end-to-end behavior:
 * describe() stamps the stored bytes' age, status reports the due date (JSON)
 * and the overdue marker (human), and doctor lists overdue keys as advisory —
 * never as a doctor failure, since aged-but-working is hygiene, not outage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'dist', 'bin.js');
const WATCHDOG_MS = 20_000;

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(cwd: string, args: string[]): CliRun {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: WATCHDOG_MS,
    input: '',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

describe('rotation surfacing (shipped CLI)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'envseal-rotation-cli-'));
    writeFileSync(join(tempDir, '.gitignore'), '.env\n');
    writeFileSync(
      join(tempDir, 'env.schema.jsonc'),
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              key: 'OVERDUE_KEY',
              description: 'rotation due immediately',
              required: false,
              secret: true,
              sink: 'dotenv',
              rotation: { maxAgeDays: 0 },
            },
            {
              key: 'PLAIN_KEY',
              description: 'no rotation policy',
              required: false,
              secret: true,
              sink: 'dotenv',
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(join(tempDir, '.env'), 'OVERDUE_KEY=sk-rotation-cli-value-1234567890\nPLAIN_KEY=sk-plain-cli-value-0987654321\n');
    writeFileSync(join(tempDir, 'AGENTS.md'), 'This repository uses envseal. Never read .env. Use envseal ensure and envseal run -- instead.\n');
    mkdirSync(join(tempDir, '.envseal'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('status --json reports rotationDue for the policy key only', () => {
    const run = runCli(tempDir, ['status', '--json']);
    expect(run.exitCode).toBe(0);

    const payload = JSON.parse(run.stdout);
    const entries = payload.entries ?? payload.command?.entries ?? payload.result?.entries;
    expect(entries).toBeDefined();

    const overdue = entries.find((e: { key: string }) => e.key === 'OVERDUE_KEY');
    const plain = entries.find((e: { key: string }) => e.key === 'PLAIN_KEY');
    expect(overdue.rotationDue).toEqual(expect.any(String));
    expect(Date.parse(overdue.rotationDue)).toBeLessThanOrEqual(Date.now());
    expect(plain.rotationDue).toBeNull();
  });

  it('human status marks the overdue key and stays silent on policy-less keys', () => {
    const run = runCli(tempDir, ['status']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('OVERDUE_KEY (rotation overdue');
    expect(run.stdout).not.toContain('PLAIN_KEY (rotation');
  });

  it('doctor lists overdue keys as advisory and still exits healthy', () => {
    const run = runCli(tempDir, ['doctor']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('Rotation overdue');
    expect(run.stdout).toContain('OVERDUE_KEY');
  });
});
