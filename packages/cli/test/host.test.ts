import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectHost } from '../src/host.js';

describe('host detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(process.cwd(), 'test-host-'));
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

  it('detects Claude Code (Tier A) by .claude directory', () => {
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'test'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('claude-code');
    expect(host.tier).toBe('A');
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
    expect(host.tier).toBe('A');
  });

  it('includes protection tier recommendation', () => {
    const host = detectHost(tempDir);
    expect(host.recommendation).toBeDefined();
    expect(host.recommendation.length).toBeGreaterThan(0);
  });
});
