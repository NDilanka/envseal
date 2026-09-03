import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyHostWiring } from '../src/host-wiring/apply.js';
import { AGENTS_MD_CONTENT } from '../src/host-wiring/agents-md-content.js';
import { AIDER_CONF_YML } from '../src/host-wiring/aider-conf.js';
import { mcpLaunch, siblingServerNames } from '../src/host-wiring/mcp.js';
import { mergeAgentsMd, hasEnvsealImperative } from '../src/host-wiring/agents-md.js';
import { aiderReadListIncludesEnv } from '../src/host-wiring/aider.js';
import { continueSnippetYaml } from '../src/host-wiring/continue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const binPath = join(__dirname, '..', 'dist', 'bin.js');
const pluginAgents = join(repoRoot, 'plugins', 'generic', 'AGENTS.md');
const pluginAider = join(repoRoot, 'plugins', 'aider', '.aider.conf.yml');
const pluginContinue = join(repoRoot, 'plugins', 'continue', 'config.yaml');

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'envseal-host-wire-'));
}

function stripAgentEnv(fakeHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === 'CLAUDECODE' ||
      k === 'CURSOR_WORKSPACE' ||
      k === 'CURSOR_VERSION' ||
      k === 'CLINE_ROOT' ||
      k === 'ZED_EDITOR' ||
      k === 'CODEX_ROOT' ||
      k === 'GOOSE_ROOT' ||
      k === 'CI'
    ) {
      continue;
    }
    env[k] = v;
  }
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  return env;
}

function runInit(
  root: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const fakeHome = mkdtempSync(join(tmpdir(), 'envseal-init-home-'));
  try {
    const result = spawnSync('node', [binPath, 'init', '--project', root, '--json', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...stripAgentEnv(fakeHome), ...extraEnv },
      timeout: 20_000,
      input: '',
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function runDoctor(root: string): { status: number | null; stdout: string } {
  const fakeHome = mkdtempSync(join(tmpdir(), 'envseal-doc-home-'));
  try {
    const result = spawnSync('node', [binPath, 'doctor', '--json', '--project', root], {
      cwd: root,
      encoding: 'utf8',
      env: stripAgentEnv(fakeHome),
      timeout: 20_000,
      input: '',
    });
    return { status: result.status, stdout: result.stdout ?? '' };
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/u, '');

describe('embedded plugin drift', () => {
  it('keeps AGENTS.md identical to plugins/generic/AGENTS.md', () => {
    expect(normalize(readFileSync(pluginAgents, 'utf8'))).toBe(normalize(AGENTS_MD_CONTENT));
  });

  it('keeps aider conf identical to plugins/aider/.aider.conf.yml', () => {
    expect(normalize(readFileSync(pluginAider, 'utf8'))).toBe(normalize(AIDER_CONF_YML));
  });

  it('keeps Continue yaml using the POSIX npx snippet', () => {
    const shipped = readFileSync(pluginContinue, 'utf8');
    expect(shipped).toContain('command: npx');
    expect(shipped).toContain('@envseal/mcp-server');
    expect(continueSnippetYaml('linux')).toContain('command: npx');
    expect(continueSnippetYaml('win32')).toContain('command: npx.cmd');
  });
});

describe('applyHostWiring', () => {
  let root: string;
  let fakeHome: string;

  beforeEach(() => {
    root = fixture();
    fakeHome = mkdtempSync(join(tmpdir(), 'envseal-wire-home-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('always merges AGENTS.md without clobbering unrelated content', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# My project\n\nDo not delete me.\n', 'utf8');
    const result = applyHostWiring(root, [], 'linux');
    expect(result.agentsMd.action).toBe('merged');
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(text).toContain('Do not delete me.');
    expect(hasEnvsealImperative(text)).toBe(true);
    const second = mergeAgentsMd(root);
    expect(second.action).toBe('unchanged');
  });

  it('writes Cursor MCP + rules on --host cursor (Windows npx.cmd)', () => {
    const result = applyHostWiring(root, ['cursor'], 'win32');
    const mcp = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: { 'envseal-mcp': { command: string; args: string[] } };
    };
    expect(mcp.mcpServers['envseal-mcp']).toEqual(mcpLaunch('win32'));
    expect(existsSync(join(root, '.cursor', 'rules', 'envseal.mdc'))).toBe(true);
    expect(existsSync(join(fakeHome, '.cursor', 'mcp.json'))).toBe(false);
    expect(result.cursor?.mcp).toBe('created');
  });

  it('writes both Cursor and Claude Code configs from dual markers', () => {
    applyHostWiring(root, ['cursor', 'claude-code'], 'linux');
    const cursor = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8'));
    const claude = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(cursor.mcpServers['envseal-mcp']).toEqual(mcpLaunch('linux'));
    expect(claude.mcpServers['envseal-mcp']).toEqual(mcpLaunch('linux'));
    expect(existsSync(join(root, '.claude'))).toBe(true);
  });

  it('writes Windsurf, Cline, Zed, JetBrains project MCP files', () => {
    applyHostWiring(root, ['windsurf', 'cline', 'zed', 'jetbrains'], 'linux');
    for (const rel of [
      '.windsurf/mcp_config.json',
      '.cline/mcp_settings.json',
      '.idea/mcp.json',
    ]) {
      const parsed = JSON.parse(readFileSync(join(root, rel), 'utf8')) as {
        mcpServers: { 'envseal-mcp': unknown };
      };
      expect(parsed.mcpServers['envseal-mcp']).toEqual(mcpLaunch('linux'));
    }
    const zed = JSON.parse(readFileSync(join(root, '.zed', 'settings.json'), 'utf8')) as {
      mcp: { 'envseal-mcp': unknown };
      other?: unknown;
    };
    expect(zed.mcp['envseal-mcp']).toEqual(mcpLaunch('linux'));
  });

  it('merges Zed settings without clobbering sibling keys', () => {
    mkdirSync(join(root, '.zed'), { recursive: true });
    writeFileSync(
      join(root, '.zed', 'settings.json'),
      JSON.stringify({ tab_size: 2, mcp: { other: { command: 'keep' } } }, null, 2) + '\n',
    );
    applyHostWiring(root, ['zed'], 'linux');
    const zed = JSON.parse(readFileSync(join(root, '.zed', 'settings.json'), 'utf8')) as {
      tab_size: number;
      mcp: Record<string, unknown>;
    };
    expect(zed.tab_size).toBe(2);
    expect(zed.mcp.other).toEqual({ command: 'keep' });
    expect(zed.mcp['envseal-mcp']).toEqual(mcpLaunch('linux'));
  });

  it('merges Copilot github.copilot.mcp into project settings.json', () => {
    applyHostWiring(root, ['copilot'], 'linux');
    const settings = JSON.parse(readFileSync(join(root, '.vscode', 'settings.json'), 'utf8')) as {
      'github.copilot.mcp': Array<{ name: string; command: string; args: string[] }>;
    };
    expect(settings['github.copilot.mcp'][0]).toEqual({
      name: 'envseal-mcp',
      ...mcpLaunch('linux'),
    });
  });

  it('merges Aider conf so .env is not on read', () => {
    writeFileSync(
      join(root, '.aider.conf.yml'),
      'read:\n  - .env\n  - README.md\n',
      'utf8',
    );
    applyHostWiring(root, ['aider'], 'linux');
    const text = readFileSync(join(root, '.aider.conf.yml'), 'utf8');
    expect(aiderReadListIncludesEnv(text)).toBe(false);
    expect(text).toContain('README.md');
    expect(text).toContain('env.schema.jsonc');
  });

  it('does not invent IDE files for generic/unknown', () => {
    applyHostWiring(root, ['generic'], 'linux');
    expect(existsSync(join(root, '.cursor'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(fakeHome, '.cursor'))).toBe(false);
  });
});

describe('envseal init (dist)', () => {
  let root: string;

  beforeEach(() => {
    root = fixture();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('init --host cursor writes mcp + rules and AGENTS.md', () => {
    expect(existsSync(binPath), `binary missing at ${binPath}`).toBe(true);
    const r = runInit(root, ['--host', 'cursor']);
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      host: string;
      protectionTier: string;
      cursorWiring?: { mcp: string; rules: string };
      agentsMd?: { action: string };
    };
    expect(parsed.cursorWiring?.mcp).toBe('created');
    expect(parsed.cursorWiring?.rules).toBe('created');
    expect(parsed.agentsMd?.action).toBe('created');
    expect(parsed.protectionTier).not.toBe('C');
    expect(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8')).toContain('@envseal/mcp-server');
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  });

  it('init with no --host on a .cursor/ tree matches --host cursor', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    const r = runInit(root, []);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'rules', 'envseal.mdc'))).toBe(true);
  });

  it('writes both MCP configs when .cursor/ and .claude/ exist', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    const r = runInit(root, []);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    const parsed = JSON.parse(r.stdout) as { wiredHosts: string[] };
    expect(parsed.wiredHosts).toEqual(expect.arrayContaining(['cursor', 'claude-code']));
  });

  it('bare tree with no process host writes AGENTS.md only', () => {
    const r = runInit(root, []);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.cursor'))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    const parsed = JSON.parse(r.stdout) as { wiringSource: string; wiredHosts: string[] };
    expect(parsed.wiringSource).toBe('none');
    expect(parsed.wiredHosts).toEqual([]);
  });

  it('init --host claude-code writes .mcp.json and does not claim Tier A', () => {
    const r = runInit(root, ['--host', 'claude-code']);
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as { host: string; protectionTier: string };
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(parsed.protectionTier).toBe('B');
    expect(r.stdout).not.toMatch(/"protectionTier":\s*"A"/);
  });

  it('init --host aider keeps .env off the read list', () => {
    const r = runInit(root, ['--host', 'aider']);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(join(root, '.aider.conf.yml'), 'utf8');
    expect(aiderReadListIncludesEnv(text)).toBe(false);
  });

  it('second init is idempotent and keeps sibling MCP servers', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        },
      }) + '\n',
    );
    expect(runInit(root, []).status).toBe(0);
    const afterFirst = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8'));
    expect(afterFirst.mcpServers.github.command).toBe('npx');
    expect(runInit(root, []).status).toBe(0);
    const afterSecond = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8'));
    expect(afterSecond).toEqual(afterFirst);
  });
});

describe('siblingServerNames', () => {
  it('lists co-registered servers sorted, excluding envseal-mcp', () => {
    expect(
      siblingServerNames({
        'envseal-mcp': { command: 'npx', args: ['-y', '@envseal/mcp-server'] },
        filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
        memory: { command: 'npx', args: ['-y', 'server-memory'] },
      }),
    ).toEqual(['filesystem', 'memory']);
  });

  it('returns an empty list when envseal-mcp is alone', () => {
    expect(
      siblingServerNames({ 'envseal-mcp': { command: 'npx.cmd', args: ['-y', '@envseal/mcp-server'] } }),
    ).toEqual([]);
  });
});

describe('envseal doctor wiring (dist)', () => {
  let root: string;

  beforeEach(() => {
    root = fixture();
    writeFileSync(
      join(root, 'env.schema.jsonc'),
      JSON.stringify({ version: 1, entries: [] }, null, 2) + '\n',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fails on empty .cursor/mcp.json (folder is not wiring)', () => {
    expect(existsSync(binPath), `binary missing at ${binPath}`).toBe(true);
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }) + '\n');
    const r = runDoctor(root);
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      host: { id: string };
      agentWiring: { mcp: string; instructions: string };
      mcp?: { wired: boolean; status: string };
    };
    expect(parsed.host.id).toBe('cursor');
    expect(parsed.agentWiring.mcp).toBe('missing');
    expect(parsed.mcp?.wired).toBe(false);
  });

  it('passes after init --host cursor', () => {
    const init = runInit(root, ['--host', 'cursor']);
    expect(init.status, init.stderr).toBe(0);
    const r = runDoctor(root);
    expect(r.status, r.stdout).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      agentWiring: { mcp: string; instructions: string };
      mcp?: { wired: boolean };
    };
    expect(parsed.agentWiring.mcp).toBe('ok');
    expect(parsed.agentWiring.instructions).toBe('ok');
    expect(parsed.mcp?.wired).toBe(true);
  });

  it('Continue after init is labeled but MCP is not OOTB', () => {
    const init = runInit(root, ['--host', 'continue']);
    expect(init.status, init.stderr).toBe(0);
    const r = runDoctor(root);
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      host: { id: string };
      agentWiring: { mcp: string; instructions: string };
      mcp?: { message: string };
    };
    expect(parsed.host.id).toBe('continue');
    expect(parsed.agentWiring.mcp).toBe('missing');
    expect(parsed.agentWiring.instructions).toBe('ok');
    expect(parsed.mcp?.message).toMatch(/not OOTB/i);
  });

  it('lists sibling MCP servers as advisory and keeps exit 0', () => {
    const init = runInit(root, ['--host', 'cursor']);
    expect(init.status, init.stderr).toBe(0);
    const mcpPath = join(root, '.cursor', 'mcp.json');
    const config = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    config.mcpServers.filesystem = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', root],
    };
    writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const r = runDoctor(root);
    expect(r.status, r.stdout).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      agentWiring: { mcp: string };
      mcp?: { wired: boolean; otherServers?: string[] };
    };
    expect(parsed.agentWiring.mcp).toBe('ok');
    expect(parsed.mcp?.wired).toBe(true);
    expect(parsed.mcp?.otherServers).toEqual(['filesystem']);
  });

  it('reports sibling server names but never their config values', () => {
    const init = runInit(root, ['--host', 'cursor']);
    expect(init.status, init.stderr).toBe(0);
    const sentinel = 'SIBLING_SENTINEL_no_real_secret_9f8c';
    const mcpPath = join(root, '.cursor', 'mcp.json');
    const config = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    config.mcpServers.filesystem = {
      command: 'npx',
      args: ['-y', 'server-filesystem', sentinel],
      env: { EXTRA_TOKEN: sentinel },
    };
    writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const r = runDoctor(root);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('filesystem');
    expect(r.stdout).not.toContain(sentinel);
  });
});
