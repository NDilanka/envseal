import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appendAudit, projectPaths } from '@envseal/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'dist', 'bin.js');

describe('envseal audit command', () => {
  let tempDir: string;

  beforeEach(() => {
    // Outside the repo: see shell-e2e for why a fixture under the workspace
    // makes findProjectRoot silently operate on this repository instead.
    tempDir = mkdtempSync(join(tmpdir(), 'envseal-audit-cli-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  function runEnvseal(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync('node', [binPath, ...args], {
      cwd: tempDir,
      encoding: 'utf-8',
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? -1,
    };
  }

  function writeAuditLog(): void {
    const paths = projectPaths(tempDir);
    appendAudit(paths, { type: 'declare', keys: ['KEY_A', 'KEY_B'] });
    appendAudit(paths, { type: 'revoke', key: 'KEY_A', sink: 'dotenv' });
  }

  it('prints recorded events as human-readable lines', () => {
    expect(existsSync(binPath), `Binary not found at ${binPath}`).toBe(true);
    writeAuditLog();

    const r = runEnvseal(['audit', '--project', tempDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('declare');
    expect(r.stdout).toContain('revoke');
  });

  it('reports an empty log without failing', () => {
    expect(existsSync(binPath), `Binary not found at ${binPath}`).toBe(true);

    const r = runEnvseal(['audit', '--project', tempDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('no audit events');
  });

  it('--json emits a parsed JSON array of events', () => {
    expect(existsSync(binPath), `Binary not found at ${binPath}`).toBe(true);
    writeAuditLog();

    const r = runEnvseal(['audit', '--json', '--project', tempDir]);
    expect(r.exitCode).toBe(0);
    const events = JSON.parse(r.stdout) as Array<{ type?: string; at?: string }>;
    expect(Array.isArray(events)).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('declare');
    expect(events[1]?.type).toBe('revoke');
  });

  it('--verify exits 0 when the chain is intact', () => {
    expect(existsSync(binPath), `Binary not found at ${binPath}`).toBe(true);
    writeAuditLog();

    const r = runEnvseal(['audit', '--verify', '--project', tempDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('intact');
  });

  it('--verify exits 7 (AUDIT_CHAIN_FAILED) when a record is tampered', () => {
    expect(existsSync(binPath), `Binary not found at ${binPath}`).toBe(true);
    const paths = projectPaths(tempDir);
    appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
    appendAudit(paths, { type: 'declare', keys: ['KEY2'] });
    appendAudit(paths, { type: 'declare', keys: ['KEY3'] });

    // Tamper on disk: flip a byte inside the middle record (JSON stays valid).
    const lines = readFileSync(paths.audit, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    const second = lines[1];
    if (second === undefined) throw new Error('expected three records on disk');
    if (!second.includes('"KEY2"')) throw new Error('fixture lost its KEY2 marker');
    lines[1] = second.replace('"KEY2"', '"KEY9"');
    writeFileSync(paths.audit, `${lines.join('\n')}\n`);

    const r = runEnvseal(['audit', '--verify', '--json', '--project', tempDir]);
    expect(r.exitCode).toBe(7);
    const payload = JSON.parse(r.stdout) as { ok?: boolean; brokenAt?: number };
    expect(payload.ok).toBe(false);
    expect(payload.brokenAt).toBe(2);
  });

  it('--verify on a project with no audit log reports ok with zero records', () => {
    expect(existsSync(binPath), `Binary not found at ${binPath}`).toBe(true);

    const r = runEnvseal(['audit', '--verify', '--project', tempDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('intact');
    expect(r.stdout).toContain('0');
  });
});
