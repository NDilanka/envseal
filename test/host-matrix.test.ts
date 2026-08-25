import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHost } from '../packages/cli/src/host.js';
import { SEP_TOOL_NAMES } from '../packages/protocol/src/index.js';

/**
 * Cross-host contract: every coding agent envseal documents must be able to
 * reach the same seven SEP tools (MCP, SDK, HTTP, or CLI) and doctor must
 * report the published protection tier for that host's project markers.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const MCP_BIN = join(ROOT, 'packages', 'mcp-server', 'dist', 'bin.js');
const CLI_BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const HOST_DOCS = join(ROOT, 'docs', 'hosts');

const EXPECTED_TOOLS = [...SEP_TOOL_NAMES];

/** Project-local markers from docs/hosts/README.md + detectHost(). */
const PROJECT_HOSTS: Array<{
  doc: string;
  id: string;
  name: string;
  tier: 'A' | 'B' | 'C';
  binding: 'mcp' | 'cli';
  setup: (root: string) => void;
}> = [
  {
    doc: 'claude-code.md',
    id: 'claude-code',
    name: 'Claude Code',
    tier: 'B', // hooks not installed in this fixture
    binding: 'mcp',
    setup: (root) => mkdirSync(join(root, '.claude')),
  },
  {
    doc: 'cursor.md',
    id: 'cursor',
    name: 'Cursor',
    tier: 'B',
    binding: 'mcp',
    setup: (root) => mkdirSync(join(root, '.cursor')),
  },
  {
    doc: 'continue.md',
    id: 'continue',
    name: 'Continue',
    tier: 'B',
    binding: 'mcp',
    setup: (root) => mkdirSync(join(root, '.continue')),
  },
  {
    doc: 'windsurf.md',
    id: 'windsurf',
    name: 'Windsurf',
    tier: 'B',
    binding: 'mcp',
    setup: (root) => mkdirSync(join(root, '.windsurf')),
  },
  {
    doc: 'cline.md',
    id: 'cline',
    name: 'Cline',
    tier: 'B',
    binding: 'mcp',
    setup: (root) => mkdirSync(join(root, '.cline')),
  },
  {
    doc: 'zed.md',
    id: 'zed',
    name: 'Zed',
    tier: 'B',
    binding: 'mcp',
    setup: (root) => mkdirSync(join(root, '.zed')),
  },
  {
    doc: 'codex.md',
    id: 'codex',
    name: 'Codex CLI',
    tier: 'B',
    binding: 'mcp',
    setup: (root) => mkdirSync(join(root, '.codex')),
  },
  {
    doc: 'jetbrains.md',
    id: 'jetbrains',
    name: 'JetBrains IDE',
    tier: 'B',
    binding: 'mcp',
    setup: (root) => mkdirSync(join(root, '.idea')),
  },
  {
    doc: 'goose.md',
    id: 'goose',
    name: 'Goose',
    tier: 'C',
    binding: 'mcp',
    setup: (root) => writeFileSync(join(root, 'goose.config.yaml'), ''),
  },
  {
    doc: 'copilot-agent.md',
    id: 'copilot',
    name: 'GitHub Copilot',
    tier: 'B',
    binding: 'mcp',
    setup: (root) => {
      mkdirSync(join(root, '.vscode'));
      writeFileSync(
        join(root, '.vscode', 'settings.json'),
        JSON.stringify({ 'github.copilot.mcp': [{ name: 'envseal-mcp', command: 'envseal-mcp' }] }),
      );
    },
  },
  {
    doc: 'aider.md',
    id: 'aider',
    name: 'Aider',
    tier: 'C',
    binding: 'cli',
    setup: (root) => writeFileSync(join(root, '.aider.conf.yml'), 'read:\n  - env.schema.jsonc\n'),
  },
  {
    doc: 'openhands.md',
    id: 'generic',
    name: 'Generic Agent',
    tier: 'B',
    binding: 'cli',
    setup: (root) => writeFileSync(join(root, 'AGENTS.md'), '# agent\n'),
  },
  {
    doc: 'shell-agent.md',
    id: 'generic',
    name: 'Generic Agent',
    tier: 'B',
    binding: 'cli',
    setup: (root) => writeFileSync(join(root, 'AGENTS.md'), '# agent\n'),
  },
];

function fencedBlocks(markdown: string, lang: string): string[] {
  const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function extractMcpCommand(config: unknown): { command: string; args: unknown } | null {
  if (typeof config !== 'object' || config === null) return null;
  const rec = config as Record<string, unknown>;
  if (typeof rec.command === 'string') {
    return { command: rec.command, args: rec.args ?? [] };
  }
  const servers = rec.mcpServers;
  if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) {
    const first = Object.values(servers as Record<string, unknown>)[0];
    return extractMcpCommand(first);
  }
  if (typeof rec.mcp === 'object' && rec.mcp !== null) {
    const inner = rec.mcp as Record<string, unknown>;
    const first = Object.values(inner)[0];
    return extractMcpCommand(first);
  }
  if (Array.isArray(rec['github.copilot.mcp'])) {
    return extractMcpCommand(rec['github.copilot.mcp'][0]);
  }
  return null;
}

interface JsonRpcResponse {
  id?: number;
  result?: { tools?: Array<{ name: string }> };
  error?: { message?: string };
}

class McpChild {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (r: JsonRpcResponse) => void>();
  stderr = '';

  constructor(projectRoot: string, bin = MCP_BIN, extraArgs: string[] = []) {
    this.child = spawn(process.execPath, [bin, '--project', projectRoot, ...extraArgs], {
      env: { ...process.env, CI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
        } catch {
          /* non-JSON */
        }
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
  }

  send(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolvePending, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}: ${this.stderr}`)), 15_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolvePending(r);
      });
      this.child.stdin.write(`${frame}\n`);
    });
  }

  async handshakeTools(): Promise<string[]> {
    const init = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'host-matrix', version: '0' },
    });
    expect(init.error, this.stderr).toBeUndefined();
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    );
    const listed = await this.send('tools/list', {});
    expect(listed.error, this.stderr).toBeUndefined();
    return (listed.result?.tools ?? []).map((t) => t.name);
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'envseal-host-matrix-'));
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  writeFileSync(
    join(dir, 'env.schema.jsonc'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          key: 'HOST_MATRIX_KEY',
          description: 'host matrix fixture',
          required: true,
          secret: true,
          sink: 'dotenv',
        },
      ],
    }),
  );
  return dir;
}

const dirs: string[] = [];
const children: McpChild[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  expect(existsSync(MCP_BIN), `build @envseal/mcp-server first: missing ${MCP_BIN}`).toBe(true);
});

describe('documented hosts have pages and detection', () => {
  it('docs/hosts covers every named host in the matrix README', () => {
    const index = readFileSync(join(HOST_DOCS, 'README.md'), 'utf8');
    const files = readdirSync(HOST_DOCS).filter((f) => f.endsWith('.md') && f !== 'README.md');
    for (const row of PROJECT_HOSTS) {
      expect(files, row.doc).toContain(row.doc);
      expect(index).toContain(row.doc.replace(/\.md$/, ''));
    }
  });

  it.each(PROJECT_HOSTS)('$name ($id) doctor marker → tier $tier', (host) => {
    const root = makeProject();
    dirs.push(root);
    host.setup(root);
    const info = detectHost(root);
    expect(info.id).toBe(host.id);
    expect(info.tier).toBe(host.tier);
    expect(info.name).toBe(host.name);
  });

  it('Claude Code is Tier A only when envseal hooks are wired', () => {
    const root = makeProject();
    dirs.push(root);
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ command: 'node envseal/hooks/pre-tool-use.cjs' }] } }),
    );
    const info = detectHost(root);
    expect(info.id).toBe('claude-code');
    expect(info.tier).toBe('A');
  });
});

describe('shipped plugin configs', () => {
  it('Cursor mcp.json launches envseal-mcp over stdio', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'plugins', 'cursor', 'mcp.json'), 'utf8')) as unknown;
    const launch = extractMcpCommand(cfg);
    expect(launch?.command).toBe('envseal-mcp');
    expect(launch?.args).toEqual([]);
  });

  it('Claude plugin .mcp.json points at the bundled CJS (exists after plugin build)', () => {
    const cfg = JSON.parse(
      readFileSync(join(ROOT, 'plugins', 'claude-code', '.mcp.json'), 'utf8'),
    ) as { mcpServers: { broker: { command: string; args: string[] } } };
    expect(cfg.mcpServers.broker.command).toBe('node');
    const rel = cfg.mcpServers.broker.args[0]?.replace('${CLAUDE_PLUGIN_ROOT}/', '') ?? '';
    expect(rel).toBe('mcp/dist/envseal-mcp.cjs');
    expect(existsSync(join(ROOT, 'plugins', 'claude-code', rel))).toBe(true);
  });

  it('Continue config registers envseal-mcp', () => {
    const yaml = readFileSync(join(ROOT, 'plugins', 'continue', 'config.yaml'), 'utf8');
    expect(yaml).toMatch(/name:\s*envseal-mcp/);
    expect(yaml).toMatch(/command:\s*envseal-mcp/);
  });

  it('Aider read-list never includes .env', () => {
    const yml = readFileSync(join(ROOT, 'plugins', 'aider', '.aider.conf.yml'), 'utf8');
    const readLines = yml
      .split(/\n/)
      .filter((line) => /^\s*-\s+\S/.test(line) && !line.trimStart().startsWith('#'));
    expect(readLines.some((line) => /^\s*-\s+\.env(\s|$)/.test(line))).toBe(false);
    expect(yml).toContain('env.schema.jsonc');
    expect(yml).toContain('.env.example');
  });

  it('Cursor rules and generic AGENTS.md forbid reading .env', () => {
    const mdc = readFileSync(join(ROOT, 'plugins', 'cursor', 'rules', 'envseal.mdc'), 'utf8');
    const agents = readFileSync(join(ROOT, 'plugins', 'generic', 'AGENTS.md'), 'utf8');
    expect(mdc).toMatch(/Never read/i);
    expect(agents).toMatch(/must never/i);
    expect(agents).toMatch(/\.env/);
    expect(mdc).not.toMatch(/cat \.env/);
    expect(agents).not.toMatch(/cat \.env/);
    for (const tool of EXPECTED_TOOLS) {
      expect(mdc, `cursor rules missing ${tool}`).toContain(tool);
    }
    expect(agents).toContain('envseal ensure');
    expect(agents).toContain('envseal run');
  });
});

describe('install snippets in docs/hosts', () => {
  it('every JSON MCP snippet launches envseal-mcp (or node + bundled bin)', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(HOST_DOCS)) {
      if (!file.endsWith('.md') || file === 'README.md') continue;
      const md = readFileSync(join(HOST_DOCS, file), 'utf8');
      for (const block of fencedBlocks(md, 'json')) {
        if (!block.includes('command')) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(block);
        } catch {
          offenders.push(`${file}: unparseable json fence`);
          continue;
        }
        const launch = extractMcpCommand(parsed);
        if (launch === null) continue;
        const ok =
          launch.command === 'envseal-mcp' ||
          (launch.command === 'node' && JSON.stringify(launch.args).includes('envseal-mcp'));
        if (!ok) offenders.push(`${file}: command=${launch.command}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('toml/yaml host snippets name envseal-mcp', () => {
    const codex = readFileSync(join(HOST_DOCS, 'codex.md'), 'utf8');
    expect(codex).toMatch(/command\s*=\s*"envseal-mcp"/);
    const goose = readFileSync(join(HOST_DOCS, 'goose.md'), 'utf8');
    expect(goose).toMatch(/cmd:\s*envseal-mcp/);
    const cont = readFileSync(join(HOST_DOCS, 'continue.md'), 'utf8');
    expect(cont).toMatch(/command:\s*envseal-mcp/);
  });
});

describe('binding tiers expose the same seven tools', () => {
  it('MCP stdio tools/list (Cursor/Claude/Windsurf/Cline/Zed/Codex/JetBrains/Goose/Copilot)', async () => {
    const root = makeProject();
    dirs.push(root);
    const child = new McpChild(root);
    children.push(child);
    const names = await child.handshakeTools();
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(child.stderr).not.toMatch(/Error/);
  });

  it('Claude Code bundled envseal-mcp.cjs serves the same tools', async () => {
    const bundled = join(ROOT, 'plugins', 'claude-code', 'mcp', 'dist', 'envseal-mcp.cjs');
    expect(existsSync(bundled)).toBe(true);
    const root = makeProject();
    dirs.push(root);
    const child = new McpChild(root, bundled);
    children.push(child);
    const names = await child.handshakeTools();
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('SDK vendor dialects each list the seven tools', () => {
    const dialectDir = join(ROOT, 'spec', 'sep-1', 'dialects');
    for (const file of ['openai.tools.json', 'anthropic.tools.json', 'gemini.tools.json', 'mcp.tools.json']) {
      const raw = JSON.parse(readFileSync(join(dialectDir, file), 'utf8')) as unknown;
      const names: string[] = [];
      const collect = (t: unknown): void => {
        if (typeof t !== 'object' || t === null) return;
        const rec = t as Record<string, unknown>;
        if (typeof rec.name === 'string' && rec.function === undefined) names.push(rec.name);
        if (typeof rec.function === 'object' && rec.function !== null && 'name' in rec.function) {
          names.push(String((rec.function as { name: string }).name));
        }
      };
      if (Array.isArray(raw)) {
        for (const t of raw) collect(t);
      } else if (typeof raw === 'object' && raw !== null) {
        const rec = raw as Record<string, unknown>;
        if (Array.isArray(rec.functionDeclarations)) {
          for (const t of rec.functionDeclarations) collect(t);
        }
        if (Array.isArray(rec.tools)) {
          for (const t of rec.tools) collect(t);
        }
      }
      expect(names.sort(), file).toEqual([...EXPECTED_TOOLS].sort());
    }
  });

  it('HTTP OpenAPI documents POST /v1/<tool> for every SEP tool', async () => {
    const { generateOpenAPI } = await import('../packages/http-server/src/openapi.js');
    const spec = generateOpenAPI(9) as { paths: Record<string, unknown> };
    for (const tool of EXPECTED_TOOLS) {
      expect(spec.paths[`/v1/${tool}`], tool).toBeDefined();
    }
  });
});

describe('CLI contract for Aider / OpenHands / shell agents', () => {
  it('envseal status --json never contains a stored value', () => {
    expect(existsSync(CLI_BIN)).toBe(true);
    const root = makeProject();
    dirs.push(root);
    writeFileSync(join(root, '.env'), 'HOST_MATRIX_KEY=sk-HOSTMATRIX-FAKE-SENTINEL-do-not-leak\n');
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const result = spawnSync(process.execPath, [CLI_BIN, 'status', '--json', '--project', root], {
      encoding: 'utf8',
      env: { ...process.env, CI: '1', HOME: root, USERPROFILE: root },
    });
    const blob = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(blob).not.toContain('sk-HOSTMATRIX-FAKE-SENTINEL');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { entries: Array<{ key: string; present: boolean }> };
    expect(parsed.entries.some((e) => e.key === 'HOST_MATRIX_KEY' && e.present)).toBe(true);
  });
});
