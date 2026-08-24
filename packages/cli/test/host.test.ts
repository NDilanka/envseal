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
    // Global markers live under the real homedir (~/.codex, ~/.cline, ...), so
    // whatever the developer happens to have installed must not leak into the
    // fixture: os.homedir() reads USERPROFILE (Windows) / HOME (POSIX) per
    // call, and pinning both to the temp dir makes every fixture's "home"
    // empty unless the test creates the marker itself.
    vi.stubEnv('USERPROFILE', tempDir);
    vi.stubEnv('HOME', tempDir);
    // Temporarily remove env vars that would interfere with detection
    vi.stubEnv('CLAUDECODE', undefined);
    vi.stubEnv('CURSOR_WORKSPACE', undefined);
    vi.stubEnv('CURSOR_VERSION', undefined);
    vi.stubEnv('CLINE_ROOT', undefined);
    vi.stubEnv('ZED_EDITOR', undefined);
    vi.stubEnv('CODEX_ROOT', undefined);
    vi.stubEnv('GOOSE_ROOT', undefined);
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

  it('detects Windsurf (Tier B) by .windsurf directory', () => {
    const windsurfDir = join(tempDir, '.windsurf');
    mkdirSync(windsurfDir, { recursive: true });

    const host = detectHost(tempDir);
    expect(host.id).toBe('windsurf');
    expect(host.tier).toBe('B');
    expect(host.reason).toMatch(/\.windsurf\//);
  });

  it('detects Cline (Tier B) by .cline directory', () => {
    const clineDir = join(tempDir, '.cline');
    mkdirSync(clineDir, { recursive: true });

    const host = detectHost(tempDir);
    expect(host.id).toBe('cline');
    expect(host.tier).toBe('B');
    expect(host.reason).toMatch(/\.cline/);
  });

  it('detects Cline (Tier B) via CLINE_ROOT', () => {
    vi.stubEnv('CLINE_ROOT', tempDir);

    const host = detectHost(tempDir);
    expect(host.id).toBe('cline');
    expect(host.tier).toBe('B');
  });

  it('detects Zed (Tier B) by .zed directory', () => {
    const zedDir = join(tempDir, '.zed');
    mkdirSync(zedDir, { recursive: true });

    const host = detectHost(tempDir);
    expect(host.id).toBe('zed');
    expect(host.tier).toBe('B');
    expect(host.reason).toMatch(/\.zed\//);
  });

  it('detects Zed (Tier B) via ZED_EDITOR', () => {
    vi.stubEnv('ZED_EDITOR', '1');

    const host = detectHost(tempDir);
    expect(host.id).toBe('zed');
    expect(host.tier).toBe('B');
  });

  it('detects Codex CLI (Tier B) by .codex directory', () => {
    const codexDir = join(tempDir, '.codex');
    mkdirSync(codexDir, { recursive: true });

    const host = detectHost(tempDir);
    expect(host.id).toBe('codex');
    expect(host.tier).toBe('B');
    expect(host.reason).toMatch(/\.codex/);
  });

  it('detects Codex CLI (Tier B) via CODEX_ROOT', () => {
    vi.stubEnv('CODEX_ROOT', tempDir);

    const host = detectHost(tempDir);
    expect(host.id).toBe('codex');
    expect(host.tier).toBe('B');
  });

  it('detects JetBrains IDE (Tier B) by .idea directory', () => {
    const ideaDir = join(tempDir, '.idea');
    mkdirSync(ideaDir, { recursive: true });

    const host = detectHost(tempDir);
    expect(host.id).toBe('jetbrains');
    expect(host.tier).toBe('B');
    expect(host.reason).toMatch(/\.idea\//);
  });

  it('detects Goose (Tier C) by goose.config.yaml', () => {
    writeFileSync(join(tempDir, 'goose.config.yaml'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('goose');
    expect(host.tier).toBe('C');
    expect(host.reason).toMatch(/goose\.config\.yaml/);
  });

  it('detects Goose (Tier C) via GOOSE_ROOT', () => {
    vi.stubEnv('GOOSE_ROOT', tempDir);

    const host = detectHost(tempDir);
    expect(host.id).toBe('goose');
    expect(host.tier).toBe('C');
  });

  it('detects Copilot (Tier B) by Copilot settings in .vscode/settings.json', () => {
    mkdirSync(join(tempDir, '.vscode'), { recursive: true });
    writeFileSync(
      join(tempDir, '.vscode', 'settings.json'),
      JSON.stringify({ 'github.copilot.enable': { '*': true } }),
    );

    const host = detectHost(tempDir);
    expect(host.id).toBe('copilot');
    expect(host.tier).toBe('B');
    expect(host.reason).toMatch(/settings\.json/);
  });

  it('does not claim Copilot from a .vscode/settings.json that never mentions it', () => {
    mkdirSync(join(tempDir, '.vscode'), { recursive: true });
    writeFileSync(
      join(tempDir, '.vscode', 'settings.json'),
      JSON.stringify({ 'editor.tabSize': 2 }),
    );
    writeFileSync(join(tempDir, 'AGENTS.md'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('generic');
  });

  it('prefers a host-specific marker over AGENTS.md', () => {
    mkdirSync(join(tempDir, '.zed'), { recursive: true });
    writeFileSync(join(tempDir, 'AGENTS.md'), '');

    const host = detectHost(tempDir);
    expect(host.id).toBe('zed');
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

  it('project-local marker beats a globally installed agent (D3)', () => {
    // The developer has ~/.codex on this machine. The project is a Cursor
    // project. The project's own marker must win.
    mkdirSync(join(tempDir, '.codex'), { recursive: true }); // "global" install
    mkdirSync(join(tempDir, 'proj', '.cursor'), { recursive: true });
    const host = detectHost(join(tempDir, 'proj'));
    expect(host.id).toBe('cursor');
  });

  it('a bare project does not inherit tier-B advice from ~/.codex alone (D3)', () => {
    // The exact machine shape that made every temp dir report codex/B during
    // the E2E: global ~/.codex exists, project carries nothing of its own.
    mkdirSync(join(tempDir, '.codex'), { recursive: true });
    const projDir = join(tempDir, 'bare-project');
    mkdirSync(projDir, { recursive: true });
    const host = detectHost(projDir);
    expect(host.id).not.toBe('codex');
    expect(host.id).toBe('unknown');
    expect(host.tier).toBe('C');
  });

  it('global Cline config degrades to generic advisory, not a false cline claim', () => {
    mkdirSync(join(tempDir, '.cline'), { recursive: true });
    const projDir = join(tempDir, 'some-project');
    mkdirSync(projDir, { recursive: true });
    const host = detectHost(projDir);
    expect(host.id).toBe('generic');
    expect(host.reason).toMatch(/no project markers/i);
  });

  it('CLAUDECODE env signal yields tier B, and loses to a project .cursor/', () => {
    vi.stubEnv('CLAUDECODE', '1');
    mkdirSync(join(tempDir, '.cursor'), { recursive: true });
    expect(detectHost(tempDir).id).toBe('cursor'); // project evidence wins

    const bare = mkdtempSync(join(tmpdir(), 'envseal-host-envonly-'));
    try {
      const envOnly = detectHost(bare);
      expect(envOnly.id).toBe('claude-code');
      expect(envOnly.tier).toBe('B');
      expect(envOnly.reason).toMatch(/no project markers/i);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
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
