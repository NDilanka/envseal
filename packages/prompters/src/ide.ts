import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asSecret } from '@envseal/protocol';
import type { PromptKeyResult, PromptRequest, PromptResponse } from './types.js';

// The VS Code side is a later phase; this adapter only discovers a registered
// broker socket and speaks one-JSON-line-per-message on top of it.

function isWindows(): boolean {
  return process.platform === 'win32';
}

const stateDir = join(homedir(), '.envseal');
const tokenPath = join(stateDir, 'ide-token');

// --- shared token ----------------------------------------------------------
// Both this prompter and the extension read `~/.envseal/ide-token`; whichever
// runs first creates it (32 random hex chars, mode 0600). Every prompt request
// carries it so an arbitrary local process cannot register itself as the
// prompter and harvest what the user types. Mirrors the extension's
// loadOrCreateToken step for step so both sides converge on the same secret no
// matter who got there first.
const tokenRegex = /^[0-9a-f]{32}$/;

let cachedToken: string | undefined;

function loadOrCreateToken(): string {
  if (cachedToken !== undefined) {
    return cachedToken;
  }
  try {
    const existing = readFileSync(tokenPath).toString('utf8').trim();
    if (tokenRegex.test(existing)) {
      cachedToken = existing;
      return cachedToken;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== 'ENOENT') {
      throw error;
    }
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!isWindows()) {
    chmodSync(stateDir, 0o700);
  }
  const fresh = randomBytes(16).toString('hex'); // 32 random hex bytes
  writeFileSync(tokenPath, fresh, { mode: 0o600 });
  if (!isWindows()) {
    chmodSync(tokenPath, 0o600);
  }
  cachedToken = fresh;
  return cachedToken;
}

function socketPath(): string {
  if (isWindows()) {
    return '\\\\.\\pipe\\envseal-ide';
  }
  return join(homedir(), '.envseal', 'ide.sock');
}

function tryConnect(timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    let socket: Socket | null = null;
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(socket);
    };
    socket = createConnection({ path: socketPath() });
    socket.once('connect', () => finish());
    socket.once('error', () => {
      socket = null;
      finish();
    });
    setTimeout(() => {
      socket?.destroy();
      socket = null;
      finish();
    }, timeoutMs).unref();
  });
}

function parseResult(raw: unknown): PromptKeyResult {
  const r = raw as { key?: unknown; outcome?: unknown; value?: unknown };
  const key = typeof r.key === 'string' ? r.key : '<unknown>';
  const outcomeRaw = r.outcome;
  const outcome =
    outcomeRaw === 'entered' || outcomeRaw === 'skipped' || outcomeRaw === 'cancelled' || outcomeRaw === 'timeout'
      ? outcomeRaw
      : 'cancelled';
  if (outcome === 'entered') {
    const value =
      typeof r.value === 'string'
        ? Buffer.from(r.value, 'utf8')
        : Array.isArray(r.value)
          ? Buffer.from(r.value as number[])
          : Buffer.alloc(0);
    return { key, outcome: 'entered', value: asSecret(value) };
  }
  return { key, outcome };
}

export class IdePrompter {
  readonly id = 'ide' as const;

  async available(): Promise<boolean> {
    const socket = await tryConnect(750);
    if (socket === null) {
      return false;
    }
    socket.destroy();
    return true;
  }

  async cancel(ticket: string): Promise<void> {
    const socket = await tryConnect(750);
    if (socket === null) {
      return;
    }
    try {
      socket.write(`${JSON.stringify({ type: 'cancel', ticket })}\n`);
    } finally {
      socket.destroy();
    }
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    // Loaded before dialing so a token-file failure never leaves a socket open.
    const token = loadOrCreateToken();
    const socket = await tryConnect(5000);
    if (socket === null) {
      throw new Error('no IDE prompter registered');
    }
    return new Promise<PromptResponse>((resolve, reject) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newlineAt = buffer.indexOf('\n');
        if (newlineAt === -1) {
          return;
        }
        const line = buffer.slice(0, newlineAt);
        let parsed: { ticket?: unknown; results?: unknown; error?: unknown };
        try {
          parsed = JSON.parse(line) as { ticket?: unknown; results?: unknown; error?: unknown };
        } catch {
          socket.destroy();
          reject(new Error('invalid response from IDE prompter'));
          return;
        }
        // A null ticket carrying an error is the extension refusing the
        // connection outright (bad or missing token). Fail fast instead of
        // falling through to the ticket-mismatch guard below, which would sit
        // here waiting for a reply that never comes.
        if (parsed.ticket === null && typeof parsed.error === 'string') {
          socket.destroy();
          reject(new Error(`IDE prompter rejected the request: ${parsed.error}`));
          return;
        }
        if (parsed.ticket !== req.ticket || !Array.isArray(parsed.results)) {
          return;
        }
        socket.destroy();
        resolve({ ticket: req.ticket, results: parsed.results.map(parseResult) });
      });
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
      // The shared token authenticates the request line; without it the
      // extension answers {ticket: null, error: 'unauthenticated'}. cancel()
      // deliberately stays token-less — the extension closes those
      // connections without answering.
      socket.write(`${JSON.stringify({ type: 'prompt', token, ...req })}\n`);
    });
  }
}