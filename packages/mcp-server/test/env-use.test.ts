import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '@envseal/core';

/**
 * env_use, end to end, against the shipped binary.
 *
 * `env_use` was advertised in tools/list and could never succeed: bin.ts built
 * the Broker with no `onConfirm`, and exec.ts reports that absence as
 * SEP_CONFIRMATION_DENIED — "the user denied the confirmation" — for a user who
 * was never asked. 439 green tests missed it because no test in this package
 * called the tool. So this file calls it, over real stdio JSON-RPC, against
 * dist/bin.js, and checks all three outcomes: approved, denied, and nowhere to
 * ask.
 *
 * Approval and denial are driven through the double-gated stub prompter
 * (ENVSEAL_TEST_MODE=1 + ENVSEAL_TEST_PROMPTER_VALUE), which answers the
 * confirmation with a fixed string. See src/test-prompter.ts.
 */

const SENTINEL = 'sk-ENVUSE-SENTINEL-DO-NOT-LEAK-8c1d0e5f7a2b';
const KEY = 'ENVUSE_TEST_KEY';
const HERE = resolve(fileURLToPath(import.meta.url), '..');
const BIN = resolve(HERE, '..', 'dist', 'bin.js');

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ type: string; text: string }>; tools?: unknown[] };
  error?: { message?: string };
}

class McpChild {
  readonly traffic: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (r: JsonRpcResponse) => void>();

  constructor(projectRoot: string, env: Record<string, string>) {
    this.child = spawn(process.execPath, [BIN, '--project', projectRoot], {
      env: { ...process.env, CI: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.traffic.push(text);
      this.buffer += text;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
        } catch {
          // Not a JSON-RPC frame; still recorded in traffic above.
        }
      }
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.traffic.push(chunk.toString('utf8'));
    });
  }

  send(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.traffic.push(frame);
    return new Promise((resolvePending, reject) => {
      // A hard watchdog: a confirmation that hangs must fail this test, not
      // stall the suite until vitest's own timeout.
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolvePending(r);
      });
      this.child.stdin.write(frame + '\n');
    });
  }

  notify(method: string, params: unknown): void {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.traffic.push(frame);
    this.child.stdin.write(frame + '\n');
  }

  async handshake(): Promise<JsonRpcResponse> {
    const init = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'env-use-test', version: '0' },
    });
    expect(init.error, 'server failed to initialize').toBeUndefined();
    this.notify('notifications/initialized', {});
    return init;
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.send('tools/call', { name, arguments: args });
    const first = res.result?.content?.[0];
    return first?.text ?? JSON.stringify(res);
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

/** A project whose only declared key already holds the sentinel. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'envseal-envuse-'));
  writeFileSync(join(dir, '.gitignore'), '.env\n', 'utf8');
  writeFileSync(join(dir, '.env'), `${KEY}=${SENTINEL}\n`, 'utf8');
  writeFileSync(
    join(dir, 'env.schema.jsonc'),
    JSON.stringify({
      version: 1,
      entries: [
        { key: KEY, description: 'env_use end-to-end fixture', required: true, secret: true, sink: 'dotenv' },
      ],
    }),
    'utf8',
  );
  return dir;
}

const dirs: string[] = [];
const children: McpChild[] = [];

function project(): string {
  const dir = makeProject();
  dirs.push(dir);
  return dir;
}

function serve(root: string, env: Record<string, string>): McpChild {
  const child = new McpChild(root, env);
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('env_use over real stdio JSON-RPC', () => {
  it('runs the command when the user approves, and redacts the value out of its output', async () => {
    const root = project();
    const mcp = serve(root, { ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_PROMPTER_VALUE: 'yes' });
    await mcp.handshake();

    const text = await mcp.callTool('env_use', {
      keys: [KEY],
      command: [process.execPath, '-e', `console.log(process.env.${KEY})`],
    });
    const result = JSON.parse(text) as {
      exitCode?: number;
      stdout?: string;
      redactedCount?: number;
      code?: string;
    };

    expect(result.code, `env_use returned an error: ${text}`).toBeUndefined();
    expect(result.exitCode).toBe(0);
    // Not vacuous: the child printed the value, so the value really was
    // injected, and it came back masked rather than raw.
    expect(result.redactedCount).toBeGreaterThan(0);
    expect(result.stdout).toContain('redacted');
    expect(result.stdout).not.toContain(SENTINEL);

    // Every byte across the process boundary, both directions, plus stderr.
    const all = mcp.traffic.join('');
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain('SENTINEL');
    expect(all).not.toContain('DO-NOT-LEAK');
  }, 60_000);

  it('refuses, and does not start the process, when the user denies', async () => {
    const root = project();
    const marker = join(root, 'the-command-ran');
    const mcp = serve(root, { ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_PROMPTER_VALUE: 'no' });
    await mcp.handshake();

    const text = await mcp.callTool('env_use', {
      keys: [KEY],
      command: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ],
    });
    const result = JSON.parse(text) as { code?: string; userMessage?: string };

    expect(result.code).toBe('SEP_CONFIRMATION_DENIED');
    // The assertion that matters: a denial has to stop the child, not just
    // report an error after it.
    expect(existsSync(marker), 'the command ran despite being denied').toBe(false);
  }, 60_000);

  it('reports a timeout, never a denial, when the confirmation expires unanswered', async () => {
    const root = project();
    const marker = join(root, 'the-command-ran');
    // ENVSEAL_TEST_PROMPTER_OUTCOME drives the refusing prompter: the dialog
    // resolves with outcome `timeout`, the shape of a real surface whose TTL
    // fired with nobody at it.
    const mcp = serve(root, {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_OUTCOME: 'timeout',
    });
    await mcp.handshake();

    const text = await mcp.callTool('env_use', {
      keys: [KEY],
      command: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ],
    });
    const result = JSON.parse(text) as { code?: string; userMessage?: string };

    expect(result.code).toBe('SEP_TICKET_EXPIRED');
    // The assertion that matters: silence must not be quoted as a refusal.
    expect(result.userMessage ?? '').not.toContain('The user denied');
    expect(existsSync(marker), 'the command ran although nobody approved it').toBe(false);
  }, 60_000);

  it('reports SEP_NO_INTERACTIVE_SURFACE — never a denial — when there is nobody to ask', async () => {
    const root = project();
    const marker = join(root, 'the-command-ran');
    // No ENVSEAL_TEST_MODE: the server resolves a real surface, and CI forces
    // `none`. This is the shape of every CI runner.
    const mcp = serve(root, { CI: '1' });
    await mcp.handshake();

    const text = await mcp.callTool('env_use', {
      keys: [KEY],
      command: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ],
    });
    const result = JSON.parse(text) as { code?: string; userMessage?: string };

    expect(result.code).toBe('SEP_NO_INTERACTIVE_SURFACE');
    expect(result.code).not.toBe('SEP_CONFIRMATION_DENIED');
    expect(result.userMessage ?? '').toContain('envseal run');
    expect(existsSync(marker), 'the command ran with nobody asked').toBe(false);
  }, 60_000);

  it('still advertises env_use, because it can now succeed', async () => {
    const root = project();
    const mcp = serve(root, { ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_PROMPTER_VALUE: 'yes' });
    await mcp.handshake();
    const list = await mcp.send('tools/list', {});
    const names = (list.result?.tools as Array<{ name: string }> | undefined)?.map((t) => t.name);
    expect(names).toContain('env_use');
  }, 60_000);
});

describe('envseal-mcp argument handling', () => {
  const run = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
      input: '',
    });

  it('prints help to stdout and exits 0', () => {
    const dir = project();
    const result = run(['--help'], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('envseal-mcp');
    expect(result.stdout).toContain('--project');
    // F-W1-3: the old bin ignored --help, wrote nothing anywhere, and left a
    // .envseal/salt behind.
    expect(result.stdout.length).toBeGreaterThan(100);
    expect(existsSync(join(dir, '.envseal'))).toBe(false);
  });

  it('prints the shipped package version and exits 0', () => {
    const dir = project();
    const pkg = JSON.parse(
      readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const result = run(['--version'], dir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`envseal-mcp ${pkg.version}`);
    expect(existsSync(join(dir, '.envseal'))).toBe(false);
  });

  it('reports the shipped package version in the initialize handshake', async () => {
    const dir = project();
    const pkg = JSON.parse(
      readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const child = new McpChild(dir, {});
    try {
      const init = await child.handshake();
      const info = (init.result ?? {}) as { serverInfo?: { version?: unknown } };
      expect(info.serverInfo?.version).toBe(pkg.version);
    } finally {
      child.kill();
    }
  });

  it.each([['--http'], ['--port', '3000'], ['--sse'], ['--project']])(
    'rejects %s with a usage error instead of ignoring it',
    (...args: string[]) => {
      const dir = project();
      const result = run(args, dir);
      expect(result.status, `${args.join(' ')} should be a usage error`).toBe(2);
      expect(result.stderr).toContain('[envseal-mcp] Error:');
      // stdout is the JSON-RPC channel; a usage error must not write to it.
      expect(result.stdout).toBe('');
      expect(existsSync(join(dir, '.envseal'))).toBe(false);
    },
  );

  it('names --http and --port as removed rather than merely unknown', () => {
    const dir = project();
    expect(run(['--http'], dir).stderr).toContain('stdio');
    expect(run(['--port', '3000'], dir).stderr).toContain('stdio');
  });

  it('refuses to start, and creates nothing, in a directory that is not a project', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'envseal-isolated-'));
    dirs.push(isolated);

    // Loud precondition: if the temp directory sits inside some other project,
    // this test would be checking the wrong branch — and a regression would
    // write .envseal/ into that project.
    expect(
      findProjectRoot(isolated),
      'fixture is not isolated: a project marker exists above the temp directory',
    ).toBe(isolated);

    const result = run([], isolated);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no project found');
    expect(readdirSync(isolated)).toEqual([]);
  });

  it('refuses a --project directory that does not exist', () => {
    const dir = project();
    const missing = join(dir, 'nope', 'still-nope');
    const result = run(['--project', missing], dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not an existing directory');
    expect(existsSync(missing)).toBe(false);
  });
});
