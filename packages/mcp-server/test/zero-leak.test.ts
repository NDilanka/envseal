import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The protocol's central claim, checked end to end against the real binary.
 *
 * Everything else in this repository is arrangement; this is the assertion that
 * the arrangement was worth making. It drives the shipped server as a separate
 * process, over the same stdio JSON-RPC transport a host would use, and records
 * every byte crossing that boundary. If a secret can reach a transcript, it has
 * to pass through here first.
 *
 * Two properties matter equally:
 *   1. the sentinel appears nowhere in the traffic, and
 *   2. the flow actually completed.
 * Without (2) a server that crashed on startup would pass, which is the classic
 * way a security test rots into decoration.
 */

const SENTINEL = 'sk-SENTINEL-DO-NOT-LEAK-9f3a2b1c8d7e6f5a4b3c2d1e';
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

  constructor(projectRoot: string) {
    this.child = spawn(process.execPath, [BIN, '--project', projectRoot], {
      env: {
        ...process.env,
        ENVSEAL_TEST_MODE: '1',
        ENVSEAL_TEST_PROMPTER_VALUE: SENTINEL,
      },
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

    // stderr is diagnostics, but it is still an egress channel a host may log.
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

  async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.send('tools/call', { name, arguments: args });
    const first = res.result?.content?.[0];
    return first?.text ?? JSON.stringify(res);
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

describe('zero-leak over real stdio JSON-RPC', () => {
  let dir: string;
  let mcp: McpChild;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'envseal-zeroleak-'));
    // The dotenv sink refuses to write where .gitignore does not cover the file.
    writeFileSync(join(dir, '.gitignore'), '.env\n', 'utf8');
    mcp = new McpChild(dir);
  });

  afterAll(() => {
    mcp?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never emits the sentinel while completing the full provisioning flow', async () => {
    const init = await mcp.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'zero-leak-test', version: '0' },
    });
    expect(init.error).toBeUndefined();
    mcp.notify('notifications/initialized', {});

    const list = await mcp.send('tools/list', {});
    expect(list.result?.tools).toHaveLength(7);

    await mcp.callTool('env_declare', {
      entries: [
        {
          key: 'ZEROLEAK_API_KEY',
          description: 'Exercised by the zero-leak test.',
          required: true,
          secret: true,
        },
      ],
    });

    const before = await mcp.callTool('env_describe', {});
    expect(before).toContain('ZEROLEAK_API_KEY');
    expect(before).toContain('"present":false');

    const ticketText = await mcp.callTool('env_request', {
      keys: ['ZEROLEAK_API_KEY'],
      reason: 'Zero-leak end-to-end check.',
    });
    const ticket = JSON.parse(ticketText) as { ticket: string };
    expect(ticket.ticket).toBeTruthy();

    const outcomeText = await mcp.callTool('env_await', {
      ticket: ticket.ticket,
      timeoutMs: 15_000,
    });
    expect(outcomeText).toContain('stored');

    // The flow genuinely completed: the key is now present, with a fingerprint
    // derived from the sentinel — proving the value really did reach the sink.
    const after = await mcp.callTool('env_describe', {});
    expect(after).toContain('"present":true');
    expect(after).toMatch(/fp_[0-9a-f]{8}/);

    // THE ASSERTION. Every byte that crossed the process boundary, in both
    // directions, including stderr.
    const all = mcp.traffic.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain('SENTINEL');
    expect(all).not.toContain('DO-NOT-LEAK');

    // W9 GAP-AUDIT extension (plan task 5.2): the flow wrote provisioning
    // records into the project's chained audit log. The sentinel must be
    // absent there too — audit records persist command lines and fingerprints,
    // never values. Read from disk so this checks the artifact, not memory.
    const { readFileSync: readAuditArtifact, existsSync: auditExists } = await import('node:fs');
    const auditPath = join(dir, '.envseal', 'audit.jsonl');
    expect(auditExists(auditPath), 'audit log should exist after provisioning').toBe(true);
    const auditRaw = readAuditArtifact(auditPath, 'utf8');
    expect(auditRaw).toContain('"type":"declare"');
    expect(auditRaw).not.toContain(SENTINEL);
  }, 60_000);
});
