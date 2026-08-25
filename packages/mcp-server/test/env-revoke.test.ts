import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * env_revoke, end to end, against the shipped binary.
 *
 * Wave 3 H9: revoke must ask the user before removing stored credentials.
 * This file calls env_revoke over real stdio JSON-RPC against dist/bin.js and
 * checks approved, denied, and no-surface outcomes — the same shape as
 * env-use.test.ts.
 */

const SENTINEL = 'sk-ENVREVOKE-SENTINEL-DO-NOT-LEAK-8c1d0e5f7a2b';
const KEY = 'ENVREVOKE_TEST_KEY';
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

  async handshake(): Promise<void> {
    const init = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'env-revoke-test', version: '0' },
    });
    expect(init.error, 'server failed to initialize').toBeUndefined();
    this.notify('notifications/initialized', {});
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

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'envseal-envrevoke-'));
  writeFileSync(join(dir, '.gitignore'), '.env\n', 'utf8');
  writeFileSync(join(dir, '.env'), `${KEY}=${SENTINEL}\n`, 'utf8');
  writeFileSync(
    join(dir, 'env.schema.jsonc'),
    JSON.stringify({
      version: 1,
      entries: [
        { key: KEY, description: 'env_revoke end-to-end fixture', required: true, secret: true, sink: 'dotenv' },
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

describe('env_revoke over real stdio JSON-RPC', () => {
  it('removes the key when the user approves, and never returns the value', async () => {
    const root = project();
    const mcp = serve(root, { ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_PROMPTER_VALUE: 'yes' });
    await mcp.handshake();

    const text = await mcp.callTool('env_revoke', { keys: [KEY] });
    const result = JSON.parse(text) as Array<{ key: string; removed: boolean; rotateUrl?: string | null }>;

    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.key).toBe(KEY);
    expect(result[0]?.removed).toBe(true);
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain(`${KEY}=`);

    const all = mcp.traffic.join('');
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain('SENTINEL');
    expect(all).not.toContain('DO-NOT-LEAK');
  }, 60_000);

  it('refuses, and does not remove the key, when the user denies', async () => {
    const root = project();
    const mcp = serve(root, { ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_PROMPTER_VALUE: 'no' });
    await mcp.handshake();

    const text = await mcp.callTool('env_revoke', { keys: [KEY] });
    const result = JSON.parse(text) as { code?: string; userMessage?: string };

    expect(result.code).toBe('SEP_CONFIRMATION_DENIED');
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`${KEY}=${SENTINEL}`);
  }, 60_000);

  it('reports a timeout, never a denial, when the confirmation expires unanswered', async () => {
    const root = project();
    const mcp = serve(root, {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_OUTCOME: 'timeout',
    });
    await mcp.handshake();

    const text = await mcp.callTool('env_revoke', { keys: [KEY] });
    const result = JSON.parse(text) as { code?: string; userMessage?: string };

    expect(result.code).toBe('SEP_TICKET_EXPIRED');
    expect(result.userMessage ?? '').not.toContain('The user denied');
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`${KEY}=${SENTINEL}`);
  }, 60_000);

  it('reports SEP_NO_INTERACTIVE_SURFACE — never a denial — when there is nobody to ask', async () => {
    const root = project();
    const mcp = serve(root, { CI: '1' });
    await mcp.handshake();

    const text = await mcp.callTool('env_revoke', { keys: [KEY] });
    const result = JSON.parse(text) as { code?: string; userMessage?: string };

    expect(result.code).toBe('SEP_NO_INTERACTIVE_SURFACE');
    expect(result.code).not.toBe('SEP_CONFIRMATION_DENIED');
    expect(result.userMessage ?? '').toContain('envseal revoke');
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`${KEY}=${SENTINEL}`);
  }, 60_000);
});
