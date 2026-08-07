import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

// envseal `ide` prompter surface. The broker (packages/prompters/src/ide.ts)
// connects to a per-user socket and speaks one-JSON-line-per-message with a
// shared secret token; this extension answers each prompt request with a VS
// Code `showInputBox({ password: true })` and returns the value to the broker.
//
// The secret value crosses exactly one boundary: user → this input box → the
// broker socket. It never reaches the model, the transcript, or any VS Code log.

const isWindows = process.platform === 'win32';

const stateDir = join(homedir(), '.envseal');
const tokenPath = join(stateDir, 'ide-token');
// POSIX: a unix socket tied to the per-user state dir (0600). Windows: a named
// pipe in the global namespace; the OS reclaims it when this process exits.
const socketPath = isWindows ? '\\\\.\\pipe\\envseal-ide' : join(stateDir, 'ide.sock');

interface KeyRequest {
  key?: unknown;
  description?: unknown;
  providerName?: unknown;
  signupUrl?: unknown;
}

interface IdeRequest {
  type?: unknown;
  token?: unknown;
  ticket?: unknown;
  nonce?: unknown;
  projectRoot?: unknown;
  reason?: unknown;
  keys?: unknown;
}

type Outcome = 'entered' | 'skipped' | 'cancelled';

interface KeyResult {
  key: string;
  outcome: Outcome;
  value?: string;
}

const tokenRegex = /^[0-9a-f]{32}$/;

let expectedToken = '';
let server: Server | undefined;

// --- shared token ----------------------------------------------------------
// Both the broker and this extension read `~/.envseal/ide-token`. Whichever
// runs first creates it (32 random hex bytes, mode 0600); the other opens the
// same bytes. Token authentication is required — without it, any local process
// could register itself as the prompter and harvest prompt contents, or forge
// result messages back to the broker. The broker's `ide.ts` sender must
// include this token in every request line.
function loadOrCreateToken(): string {
  try {
    const existing = readFileSync(tokenPath).toString('utf8').trim();
    if (tokenRegex.test(existing)) {
      return existing;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== 'ENOENT') {
      throw error;
    }
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!isWindows) {
    chmodSync(stateDir, 0o700);
  }
  const fresh = randomBytes(16).toString('hex'); // 32 random hex bytes
  writeFileSync(tokenPath, fresh, { mode: 0o600 });
  if (!isWindows) {
    chmodSync(tokenPath, 0o600);
  }
  return fresh;
}

// timingSafeEqual throws when the inputs differ in length, so gate on length
// before comparing. Both sides derive from the same 32-hex file, so a valid
// nonce-supplied value always has length 32.
function tokenIsValid(supplied: unknown): boolean {
  if (typeof supplied !== 'string') {
    return false;
  }
  const actual = Buffer.from(supplied, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

// --- per-connection handling ----------------------------------------------
function handleSocket(socket: Socket): void {
  let buffer = '';
  let answered = false;

  const reply = (obj: unknown): void => {
    if (answered) {
      return;
    }
    answered = true;
    socket.end(`${JSON.stringify(obj)}\n`);
  };

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    // MCP-style line framing: one JSON object per line.
    const newlineAt = buffer.indexOf('\n');
    if (newlineAt === -1) {
      return;
    }
    const line = buffer.slice(0, newlineAt);
    buffer = buffer.slice(newlineAt + 1);
    if (answered) {
      return; // one request per connection
    }
    void handleLine(line).then(reply, (error: unknown) => {
      const message = error instanceof Error ? error.message : 'internal error';
      reply({ ticket: null, error: `internal error: ${message}` });
    });
  });

  socket.on('error', () => {
    // Remote side closed in the middle of a prompt; the broker times out the
    // ticket on its own. Nothing to surface.
  });
}

async function handleLine(line: string): Promise<Record<string, unknown>> {
  let req: IdeRequest;
  try {
    req = JSON.parse(line) as IdeRequest;
  } catch {
    return { ticket: null, error: 'invalid request' };
  }

  // The broker's cancel probe (`{type: 'cancel', ticket}`) opens its own
  // connection and does not hold a token; close silently instead of answering.
  if (req.type === 'cancel') {
    return {};
  }

  // Token authentication is required — see loadOrCreateToken.
  if (!tokenIsValid(req.token)) {
    return { ticket: null, error: 'unauthenticated' };
  }

  const ticket = typeof req.ticket === 'string' ? req.ticket : '';
  const nonce = typeof req.nonce === 'string' ? req.nonce : '';
  const projectRoot = typeof req.projectRoot === 'string' ? req.projectRoot : '';
  const reason = typeof req.reason === 'string' ? req.reason : '';
  const keys = Array.isArray(req.keys) ? req.keys : [];

  const results = await promptForKeys({ ticket, nonce, projectRoot, reason, keys });
  return { ticket, results };
}

interface PromptContext {
  ticket: string;
  nonce: string;
  projectRoot: string;
  reason: string;
  keys: KeyRequest[];
}

// One key at a time. Each key gets its own outcome so the broker can report
// the exact state of the ticket; pressing Escape leaves a key uncancelled
// (outcome `cancelled`), submitting empty marks it `skipped`.
async function promptForKeys(ctx: PromptContext): Promise<KeyResult[]> {
  const results: KeyResult[] = [];
  for (const entry of ctx.keys) {
    const key = typeof entry.key === 'string' ? entry.key : undefined;
    if (key === undefined) {
      continue;
    }
    const description =
      typeof entry.description === 'string' && entry.description.length > 0
        ? entry.description
        : undefined;
    const providerName =
      typeof entry.providerName === 'string' && entry.providerName.length > 0
        ? entry.providerName
        : undefined;
    const signupUrl =
      typeof entry.signupUrl === 'string' && entry.signupUrl.length > 0
        ? entry.signupUrl
        : undefined;

    // The nonce and the agent's verbatim reason are both shown so the user can
    // confirm this really came from this agent session (the anti-phishing
    // control, SEP/1 §5.2/T9, applied to the IDE surface).
    const titleParts = ['envseal', ctx.nonce];
    if (providerName !== undefined) {
      titleParts.push(providerName);
    }
    titleParts.push(key);

    const promptLines: string[] = [
      `Code (nonce): ${ctx.nonce}`,
      '',
      'Reason (exactly what the agent asked for):',
      ctx.reason,
    ];
    if (description !== undefined) {
      promptLines.push('', `Description: ${description}`);
    }
    if (signupUrl !== undefined) {
      promptLines.push(`Get a key: ${signupUrl}`);
    }
    if (ctx.projectRoot !== '') {
      promptLines.push(`Project: ${ctx.projectRoot}`);
    }

    const value = await vscode.window.showInputBox({
      password: true,
      ignoreFocusOut: true,
      title: titleParts.join(' · '),
      prompt: promptLines.join('\n'),
      placeHolder: `Paste ${key} here`,
    });

    if (value === undefined) {
      results.push({ key, outcome: 'cancelled' });
    } else if (value === '') {
      results.push({ key, outcome: 'skipped' });
    } else {
      results.push({ key, outcome: 'entered', value });
    }
  }
  return results;
}

// --- lifecycle -------------------------------------------------------------
function startServer(): void {
  expectedToken = loadOrCreateToken();

  // A stale socket file survives extension-host crashes on POSIX. Remove it so
  // `listen` does not hit EADDRINUSE; if the file is still held by a live
  // process, listen below fails and is surfaced instead. Windows named pipes
  // are reclaimed by the OS, so this is POSIX-only.
  if (!isWindows && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // fall through; listen will report the real failure
    }
  }

  server = createServer(handleSocket);
  server.on('error', (error: Error) => {
    // Fail visibly but do not crash the extension host: the broker falls back
    // to another prompter surface when the socket is unreachable.
    void vscode.window.showWarningMessage(
      `envseal: IDE prompter socket failed (${error.message}). ` +
        'The broker will fall back to another secret input surface.',
    );
  });
  server.listen(socketPath);
}

function stopServer(): void {
  if (server !== undefined) {
    server.close();
    server = undefined;
  }
  if (!isWindows && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // already gone; nothing to clean up
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  startServer();

  // The command is smoke-test sugar — the IDE surface is driven by the broker
  // over the socket, not by the user. Executing it proves activation ran.
  context.subscriptions.push(
    vscode.commands.registerCommand('envseal.provideSecret', () => {
      return vscode.window.showInformationMessage(
        'envseal: IDE prompter socket is listening. Requests arrive from the broker.',
      );
    }),
    { dispose: () => stopServer() },
  );
}

// Clean up the socket when the extension host stops *and* on process exit, so
// a hard kill leaves no stale socket file behind on the next launch.
process.once('exit', () => {
  stopServer();
});

export function deactivate(): void {
  stopServer();
}