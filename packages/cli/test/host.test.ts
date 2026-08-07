import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectHost } from '../src/host.js';

describe('host detection', () => {
  let tempDir: string;

  beforeEach(() => {
    // Must live OUTSIDE the repo. Under process.cwd() the fixture inherits the
    // repo's own host markers (.claude/, AGENTS.md, ...), so detection can pass
    // for the wrong reason, and a failed rmSync leaves dirs in the source tree.
    tempDir = mkdtempSync(join(tmpdir(), 'envseal-test-host-'));
    // Temporarily remove env vars that would interfere with detection
    vi.stubEnv('CLAUDECODE', undefined);
    vi.stubEnv('CURSOR_WORKSPACE', undefined);
    vi.stubEnv('CURSOR_VERSION', undefined);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      /* ignore */
    }
    vi.unstubAllEnvs();
  });

  it('reports Claude Code at Tier B when the plugin is not installed', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'test'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('claude-code');
    // Tier A is earned by the hooks actually being wired, not by the harness
    // being present. Claiming otherwise tells the user a shell read of the
    // dotenv file is blocked when nothing is blocking it.
    expect(host.tier).toBe('B');
    expect(host.reason).toMatch(/hooks were not found/i);
  });

  it('detects Cursor (Tier B) by .cursor directory', () => {
    const cursorDir = join(tempDir, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'test'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('cursor');
    expect(host.tier).toBe('B');
  });

  it('detects Continue (Tier B) by .continue directory', () => {
    const continueDir = join(tempDir, '.continue');
    mkdirSync(continueDir, { recursive: true });
    writeFileSync(join(continueDir, 'test'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('continue');
    expect(host.tier).toBe('B');
  });

  it('detects Aider (Tier C) by .aider.conf.yml', () => {
    writeFileSync(join(tempDir, '.aider.conf.yml'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('aider');
    expect(host.tier).toBe('C');
  });

  it('detects generic agent (Tier B) by AGENTS.md', () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('generic');
    expect(host.tier).toBe('B');
  });

  it('returns unknown for empty directory', () => {
    const host = detectHost(tempDir);
    expect(host.id).toBe('unknown');
    expect(host.tier).toBe('C');
  });

  it('reports Tier A only when envseal hooks are wired into settings', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ command: 'node envseal/hooks/pre-tool-use.cjs' }] } }),
    );

    const host = detectHost(tempDir);
    expect(host.id).toBe('claude-code');
    expect(host.tier).toBe('A');
    expect(host.recommendation).toMatch(/blocked/i);
  });

  it('prioritizes Claude Code over other hosts', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'test'), '');

    const cursorDir = join(tempDir, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'test'), '');

    writeFileSync(join(tempDir, 'AGENTS.md'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('claude-code');
    expect(host.tier).toBe('B');
  });

  it('includes protection tier recommendation', () => {
    const host = detectHost(tempDir);
    expect(host.recommendation).toBeDefined();
    expect(host.recommendation.length).toBeGreaterThan(0);
  });
});
