/**
 * Manifest-required and spawn-failure honesty (D1/D2 from the 2026-08-24 E2E).
 *
 * Asserted against the shipped binary, same discipline as contract-e2e.test.ts:
 * numeric exit codes with toBe, fixtures outside the repo, hard watchdog.
 *
 * The behavioural split under test:
 *   - `doctor` is an AUDIT: with no env.schema.jsonc it must fail with
 *     SEP_NOT_DECLARED / exit 2, the same treatment as `ensure`. Reporting an
 *     empty, healthy bill of health for an unconfigured project is the exact
 *     "should work" dishonesty this suite exists to prevent.
 *   - `status` is a READ-ONLY report: exit 0 with zero entries remains correct
 *     (documented in ensure.ts and now in docs/cli-contract.md) — this test
 *     PINS that so a future "fix" cannot flip it silently either way.
 *   - `envseal mcp` must not turn "the server binary could not be executed"
 *     into exit 0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): CliRun {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CI' || v === undefined) continue;
    base[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: base,
    timeout: WATCHDOG_MS,
    input: '',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

describe('doctor/status on a project with NO manifest', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'envseal-nomanifest-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* open handles must not fail the assertion above */
    }
  });

  it('doctor refuses with exit 2 and SEP_NOT_DECLARED (--json)', () => {
    const r = runCli(tempDir, ['doctor', '--project', tempDir, '--json']);
    expect(r.exitCode).toBe(2);
    const body = JSON.parse(r.stdout);
    expect(body.code).toBe('SEP_NOT_DECLARED');
    expect(body.userMessage).toContain('envseal init');
  });

  it('doctor refuses with exit 2 in human mode too', () => {
    const r = runCli(tempDir, ['doctor', '--project', tempDir]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('No env.schema.jsonc');
  });

  it('status stays a truthful empty report: exit 0, zero entries', () => {
    // Deliberate, documented behaviour — pinned here so neither direction flips
    // silently: an audit refuses, a read-only report reports emptiness.
    const r = runCli(tempDir, ['status', '--project', tempDir, '--json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).entries).toEqual([]);
  });
});

describe('mcp: spawn failure must not be success', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'envseal-mcpfail-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits 5 with a diagnostic when envseal-mcp cannot be executed', () => {
    // An empty PATH makes the wrapper's spawnSync('envseal-mcp', ...) fail with
    // ENOENT inside the child. The old `result.status ?? 0` reported exit 0.
    // The CLI itself is spawned by absolute path so the harness does not depend
    // on PATH resolution.
    const r = runCli(tempDir, ['mcp', '--project', tempDir], { PATH: '' });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain('envseal-mcp');
    expect(r.stdout).not.toContain('Usage');
  });
});
