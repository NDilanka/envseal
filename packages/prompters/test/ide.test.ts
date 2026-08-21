import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IdePrompter } from '../src/ide.js';
import type { PromptRequest } from '../src/types.js';

// Drives the real wire protocol between the broker's IdePrompter and the VS
// Code extension's socket server: a net server listens on the exact path the
// prompter dials and answers the way extension.ts does. The token file under
// the real home dir is shared state with any live extension — tests may let
// the prompter create it but never delete it.

const isWindows = process.platform === 'win32';
const SOCKET_PATH = isWindows ? '\\\\.\\pipe\\envseal-ide' : join(homedir(), '.envseal', 'ide.sock');
const TOKEN_PATH = join(homedir(), '.envseal', 'ide-token');

type Handler = (req: Record<string, unknown>, socket: Socket) => void;

const seen: Array<Record<string, unknown>> = [];
let handler: Handler = () => {};

function send(socket: Socket, obj: unknown): void {
  socket.write(`${JSON.stringify(obj)}\n`);
}

function handleConnection(socket: Socket): void {
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const newlineAt = buffer.indexOf('\n');
    if (newlineAt === -1) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(buffer.slice(0, newlineAt)) as Record<string, unknown>;
    } catch {
      return;
    }
    seen.push(parsed);
    handler(parsed, socket);
  });
  socket.on('error', () => {});
}

// A live extension may already own the path; if we cannot bind it the whole
// file skips rather than fighting over the pipe.
const server = createServer(handleConnection);
const listening = await new Promise<boolean>((resolve) => {
  // Same stale-socket dance as the extension: a crashed run leaves the file
  // behind on POSIX and listen would hit EADDRINUSE.
  if (!isWindows && existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // listen reports the real failure
    }
  }
  server.once('error', () => resolve(false));
  server.listen(SOCKET_PATH, () => resolve(true));
});

afterAll(() => {
  server.close();
  if (!isWindows && listening && existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // already gone
    }
  }
});

function makeRequest(ticket: string): PromptRequest {
  return {
    ticket,
    nonce: '7F2A-91C4',
    projectRoot: '/tmp/envseal-test',
    reason: 'A test needs an API key',
    keys: [{ key: 'OPENAI_API_KEY', description: 'OpenAI API key for the test' }],
    timeoutMs: 5000,
  };
}

function uniqueTicket(): string {
  return `tkt_${randomBytes(8).toString('hex')}`;
}

async function waitForSeen(
  predicate: (req: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const match = seen.find(predicate);
    if (match !== undefined) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the fake IDE server never received the expected request');
}

describe.skipIf(!listening)('ide prompter over the real socket', () => {
  beforeEach(() => {
    seen.length = 0;
    handler = () => {};
  });

  it('authenticates with the shared token and resolves the entered value', async () => {
    const ticket = uniqueTicket();
    handler = (req, socket) => {
      // Same validation the extension performs: compare against the token
      // file both sides share.
      let expected = '';
      try {
        expected = readFileSync(TOKEN_PATH, 'utf8').trim();
      } catch {
        // missing file -> empty expected -> mismatch -> unauthenticated
      }
      if (req.token !== expected) {
        send(socket, { ticket: null, error: 'unauthenticated' });
        return;
      }
      send(socket, {
        ticket,
        results: [{ key: 'OPENAI_API_KEY', outcome: 'entered', value: 'sk-happy-path-value' }],
      });
    };

    const outcome = await new IdePrompter().prompt(makeRequest(ticket));
    expect(outcome.ticket).toBe(ticket);
    const entry = outcome.results.find((r) => r.key === 'OPENAI_API_KEY');
    if (entry === undefined || entry.outcome !== 'entered') {
      throw new Error(`expected an entered result, got ${JSON.stringify(entry ?? null)}`);
    }
    expect(entry.value.toString('utf8')).toBe('sk-happy-path-value');
  });

  // Regression guard: the sender used to omit the token, and the extension's
  // {ticket: null, error} reply fell through the ticket-mismatch guard, so
  // prompt() hung until the broker-level TTL instead of failing fast.
  it('rejects promptly when the extension answers with ticket:null and an error', async () => {
    const ticket = uniqueTicket();
    handler = (_req, socket) => {
      send(socket, { ticket: null, error: 'unauthenticated' });
    };

    await expect(new IdePrompter().prompt(makeRequest(ticket))).rejects.toThrow(
      'IDE prompter rejected the request: unauthenticated',
    );
  });

  it('sends cancel without a token field', async () => {
    const ticket = uniqueTicket();

    await new IdePrompter().cancel(ticket);

    const line = await waitForSeen((req) => req.type === 'cancel' && req.ticket === ticket);
    expect('token' in line).toBe(false);
  });

  it('rejects on a malformed reply line', async () => {
    const ticket = uniqueTicket();
    handler = (_req, socket) => {
      socket.write('this is not json\n');
    };

    await expect(new IdePrompter().prompt(makeRequest(ticket))).rejects.toThrow(
      'invalid response from IDE prompter',
    );
  });
});
