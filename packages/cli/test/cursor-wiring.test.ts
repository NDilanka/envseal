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
import {
  cursorMcpLaunch,
  cursorMcpSnippetJson,
  inspectCursorMcp,
  isEmptyEnvsealStub,
  isStockNpxLaunch,
  writeCursorHostFiles,
} from '../src/host-wiring/cursor.js';
import { CURSOR_RULES_MDC } from '../src/host-wiring/cursor-rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const binPath = join(__dirname, '..', 'dist', 'bin.js');
const pluginMcp = join(repoRoot, 'plugins', 'cursor', 'mcp.json');
const pluginRules = join(repoRoot, 'plugins', 'cursor', 'rules', 'envseal.mdc');

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'envseal-cursor-wire-'));
}

describe('cursor MCP launch snippet', () => {
  it('uses npx on POSIX and npx.cmd on Windows, never --project', () => {
    expect(cursorMcpLaunch('linux')).toEqual({
      command: 'npx',
      args: ['-y', '@envseal/mcp-server'],
    });
    expect(cursorMcpLaunch('darwin')).toEqual({
      command: 'npx',
      args: ['-y', '@envseal/mcp-server'],
    });
    expect(cursorMcpLaunch('win32')).toEqual({
      command: 'npx.cmd',
      args: ['-y', '@envseal/mcp-server'],
    });
    expect(JSON.stringify(cursorMcpLaunch('win32'))).not.toMatch(/--project/);
  });

  it('keeps plugins/cursor/mcp.json identical to the POSIX snippet', () => {
    const shipped = JSON.parse(readFileSync(pluginMcp, 'utf8')) as {
      mcpServers: { 'envseal-mcp': { command: string; args: string[] } };
    };
    expect(shipped.mcpServers['envseal-mcp']).toEqual(cursorMcpLaunch('linux'));
  });

  it('keeps plugins/cursor/rules/envseal.mdc identical to the embedded copy', () => {
    const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/u, '');
    expect(normalize(readFileSync(pluginRules, 'utf8'))).toBe(normalize(CURSOR_RULES_MDC));
  });

  it('treats the old envseal-mcp PATH stub as replaceable', () => {
    expect(isEmptyEnvsealStub({ command: 'envseal-mcp', args: [] })).toBe(true);
    expect(isEmptyEnvsealStub({ command: 'envseal-mcp' })).toBe(true);
    expect(isStockNpxLaunch({ command: 'npx', args: ['-y', '@envseal/mcp-server'] })).toBe(true);
    expect(
      isStockNpxLaunch({
        command: 'node',
        args: ['/opt/envseal/packages/mcp-server/dist/bin.js'],
      }),
    ).toBe(false);
  });
});

describe('writeCursorHostFiles', () => {
  let root: string;
  let fakeHome: string;

  beforeEach(() => {
    root = fixture();
    fakeHome = mkdtempSync(join(tmpdir(), 'envseal-cursor-home-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('creates .cursor/mcp.json with the platform npx argv on a clean tree', () => {
    const result = writeCursorHostFiles(root, process.platform);
    expect(result.mcp).toBe('created');
    expect(result.rules).toBe('created');
    expect(result.reloadHint).toMatch(/Settings → MCP/);

    const parsed = JSON.parse(readFileSync(result.mcpPath, 'utf8')) as {
      mcpServers: { 'envseal-mcp': { command: string; args: string[] } };
    };
    expect(parsed.mcpServers['envseal-mcp']).toEqual(cursorMcpLaunch(process.platform));
    expect(readFileSync(result.rulesPath, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/u, '')).toBe(
      CURSOR_RULES_MDC.replace(/\s+$/u, ''),
    );
    expect(existsSync(join(fakeHome, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('preserves sibling MCP servers and is idempotent', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const first = writeCursorHostFiles(root, 'linux');
    expect(first.mcp).toBe('merged');
    const afterFirst = JSON.parse(readFileSync(first.mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(afterFirst.mcpServers.github).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    expect(afterFirst.mcpServers['envseal-mcp']).toEqual(cursorMcpLaunch('linux'));

    const second = writeCursorHostFiles(root, 'linux');
    expect(second.mcp).toBe('unchanged');
    expect(second.rules).toBe('unchanged');
    expect(JSON.parse(readFileSync(second.mcpPath, 'utf8'))).toEqual(afterFirst);
  });

  it('does not overwrite a hand-edited envseal-mcp entry', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    const custom = {
      mcpServers: {
        'envseal-mcp': {
          command: 'node',
          args: ['/opt/custom/envseal-mcp.js'],
        },
        other: { command: 'echo' },
      },
    };
    writeFileSync(join(root, '.cursor', 'mcp.json'), JSON.stringify(custom, null, 2) + '\n');

    const result = writeCursorHostFiles(root, 'linux');
    expect(result.mcp).toBe('unchanged');
    expect(JSON.parse(readFileSync(result.mcpPath, 'utf8'))).toEqual(custom);
  });

  it('replaces the empty envseal-mcp stub but keeps siblings', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            sibling: { command: 'keep-me' },
            'envseal-mcp': { command: 'envseal-mcp', args: [] },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const result = writeCursorHostFiles(root, 'win32');
    expect(result.mcp).toBe('merged');
    const parsed = JSON.parse(readFileSync(result.mcpPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.sibling).toEqual({ command: 'keep-me' });
    expect(parsed.mcpServers['envseal-mcp']).toEqual(cursorMcpLaunch('win32'));
  });

  it('does not clobber an existing rules file', () => {
    const rulesPath = join(root, '.cursor', 'rules', 'envseal.mdc');
    mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
    writeFileSync(rulesPath, 'user-edited\n', 'utf8');
    const result = writeCursorHostFiles(root, 'linux');
    expect(result.rules).toBe('unchanged');
    expect(readFileSync(rulesPath, 'utf8')).toBe('user-edited\n');
  });

  it('skips an unreadable mcp.json instead of wiping it', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    const path = join(root, '.cursor', 'mcp.json');
    writeFileSync(path, '{ not json', 'utf8');
    const result = writeCursorHostFiles(root, 'linux');
    expect(result.mcp).toBe('skipped');
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});

describe('inspectCursorMcp', () => {
  let root: string;

  beforeEach(() => {
    root = fixture();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports unwired MCP on a .cursor/ tree with empty mcpServers', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }) + '\n');
    const inspection = inspectCursorMcp(root, { probe: false, platform: 'linux' });
    expect(inspection.wired).toBe(false);
    expect(inspection.status).toBe('missing');
    expect(inspection.message).toContain('envseal init');
    expect(inspection.message).not.toMatch(/plugins\//);
    expect(inspection.message).toContain(cursorMcpSnippetJson('linux'));
  });

  it('reports the PATH stub as unwired', () => {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { 'envseal-mcp': { command: 'envseal-mcp', args: [] } } }) + '\n',
    );
    const inspection = inspectCursorMcp(root, { probe: false });
    expect(inspection.wired).toBe(false);
    expect(inspection.status).toBe('stub');
    expect(inspection.message).toContain('envseal init');
  });

  it('reports wired for the npx snippet without probing npx', () => {
    writeCursorHostFiles(root, 'linux');
    const inspection = inspectCursorMcp(root, { probe: true, platform: 'linux' });
    expect(inspection.wired).toBe(true);
    expect(inspection.status).toBe('wired');
    expect(inspection.commandOk).toBeNull();
  });
});

describe('envseal init --host cursor (dist)', () => {
  let root: string;

  beforeEach(() => {
    root = fixture();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a schema-valid .cursor/mcp.json and does not touch $HOME', () => {
    expect(existsSync(binPath), `binary missing at ${binPath}`).toBe(true);
    const fakeHome = mkdtempSync(join(tmpdir(), 'envseal-cursor-init-home-'));
    try {
      const result = spawnSync('node', [binPath, 'init', '--host', 'cursor', '--project', root, '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CI: undefined },
        timeout: 20_000,
        input: '',
      });
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        host: string;
        cursorWiring?: { mcp: string; rules: string };
      };
      expect(parsed.host).toBe('cursor');
      expect(parsed.cursorWiring?.mcp).toBe('created');
      expect(parsed.cursorWiring?.rules).toBe('created');

      const mcp = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8')) as {
        mcpServers: { 'envseal-mcp': { command: string; args: unknown } };
      };
      expect(mcp.mcpServers['envseal-mcp']).toEqual(cursorMcpLaunch(process.platform));
      expect(existsSync(join(fakeHome, '.cursor', 'mcp.json'))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('envseal doctor Cursor MCP (dist)', () => {
  let root: string;

  beforeEach(() => {
    root = fixture();
    writeFileSync(
      join(root, 'env.schema.jsonc'),
      JSON.stringify({ version: 1, entries: [] }, null, 2) + '\n',
    );
    mkdirSync(join(root, '.cursor'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 1 and names envseal init when mcpServers is empty', () => {
    expect(existsSync(binPath), `binary missing at ${binPath}`).toBe(true);
    writeFileSync(join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }) + '\n');
    const result = spawnSync('node', [binPath, 'doctor', '--json', '--project', root], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      input: '',
    });
    expect(result.status, result.stderr).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      host: { id: string };
      agentWiring?: { mcp: string; instructions: string };
      mcp?: { wired: boolean; status: string; message: string };
    };
    expect(parsed.host.id).toBe('cursor');
    expect(parsed.agentWiring?.mcp).toBe('missing');
    expect(parsed.mcp?.wired).toBe(false);
    expect(parsed.mcp?.status).toBe('missing');
    expect(parsed.mcp?.message).toContain('envseal init');
    expect(parsed.mcp?.message).not.toMatch(/plugins\//);
  });
});
