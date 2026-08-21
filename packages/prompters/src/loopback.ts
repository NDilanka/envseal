import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import type { Socket } from 'node:net';
import { asSecret } from '@envseal/protocol';
import type {
  Prompter,
  PromptRequest,
  PromptResponse,
  PromptKeyRequest,
  PromptKeyResult,
} from './types.js';

const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const VALUE_FIELD = (key: string): string => `env_value.${key}`;
const SKIP_FIELD = (key: string): string => `env_skip.${key}`;

export interface LoopbackResult extends PromptResponse {
  /** Set when the platform opener could not be launched; the caller should print it. */
  url?: string;
}

export interface LoopbackPrompterOptions {
  openBrowser?: boolean;
  onListening?: (info: { port: number; pathNonce: string; url: string }) => void;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function secureEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://');
}

function securityHeaders(styleNonce: string, scriptNonce: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      `default-src 'none'; style-src 'nonce-${styleNonce}'; ` +
      `script-src 'nonce-${scriptNonce}'; form-action 'self'; base-uri 'none'`,
  };
}

function respondText(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string>,
): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    Connection: 'close',
    ...headers,
  });
  res.end(body);
}

function renderKeySection(key: PromptKeyRequest): string {
  const sectionId = `field-${key.key}`;
  const revealId = `reveal-${key.key}`;
  let signup = '';
  if (isHttpUrl(key.signupUrl ?? '')) {
    signup =
      `      <p class="signup"><a href="${escapeHtml(key.signupUrl ?? '')}" ` +
      `rel="noreferrer noopener" target="_blank">Get your key</a></p>\n`;
  }
  let docs = '';
  if (isHttpUrl(key.docsUrl ?? '')) {
    docs =
      `      <p class="docs"><a href="${escapeHtml(key.docsUrl ?? '')}" ` +
      `rel="noreferrer noopener" target="_blank">Documentation</a></p>\n`;
  }
  let hint = '';
  if (key.formatHint) {
    hint = `      <p class="hint">${escapeHtml(key.formatHint)}</p>\n`;
  }
  let provider = '';
  if (key.providerName) {
    provider = `      <p class="provider">Provider: ${escapeHtml(key.providerName)}</p>\n`;
  }
  let skip = '';
  if (key.optional) {
    skip =
      `      <label class="skip"><input type="checkbox" ` +
      `name="${escapeHtml(SKIP_FIELD(key.key))}" value="1"> Skip this key</label>\n`;
  }
  // W3-01: these two attributes are the only place a key name reaches the page
  // without escapeHtml. Unreachable through the product path today (the
  // manifest's zod key pattern is /^[A-Z][A-Z0-9_]{0,63}$/) and contained by
  // the nonce-only CSP, but this is the one file that renders
  // attacker-influenced strings next to a live credential field, so the
  // escaping contract holds without exception.
  return `    <section class="key" id="${escapeHtml(sectionId)}">
      <h2>${escapeHtml(key.key)}</h2>
      <p class="description">${escapeHtml(key.description)}</p>
${provider}${hint}${signup}${docs}      <div class="input-row">
        <input type="password" name="${escapeHtml(VALUE_FIELD(key.key))}" id="${escapeHtml(revealId)}"
          autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
          data-1p-ignore data-lpignore="true" placeholder="Enter value">
        <button type="button" data-reveal="${escapeHtml(revealId)}">Show</button>
      </div>
${skip}    </section>
`;
}

function renderForm(
  req: PromptRequest,
  opts: { pathNonce: string; csrf: string; styleNonce: string; scriptNonce: string },
): string {
  const fields = req.keys.map((k) => renderKeySection(k)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>EnvSeal credential prompt</title>
<style nonce="${opts.styleNonce}">
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.45; }
  .nonce { font-size: 1.4rem; font-weight: 700; padding: 0.75rem 1rem; border: 1px solid currentColor; border-radius: 6px; }
  .meta { color: #777; }
  .reason { font-size: 1.1rem; white-space: pre-wrap; background: rgba(127,127,127,.12); padding: 0.75rem 1rem; border-radius: 6px; }
  .key { border-top: 1px solid rgba(127,127,127,.4); padding: 1rem 0; }
  .key h2 { margin: 0 0 .25rem; font-size: 1.05rem; }
  .description { margin: 0 0 .25rem; white-space: pre-wrap; }
  .hint, .signup, .docs, .provider { margin: 0 0 .25rem; font-size: .9rem; color: #888; }
  .input-row { display: flex; gap: .5rem; align-items: center; margin: .5rem 0; }
  input[type="password"] { flex: 1; padding: .45rem .6rem; font-size: 1rem; }
  button { padding: .45rem .9rem; font-size: 1rem; cursor: pointer; }
  .skip { font-size: .9rem; }
  input[type="submit"] { padding: .6rem 1.4rem; font-size: 1.05rem; }
</style>
</head>
<body>
<main>
  <h1>EnvSeal</h1>
  <p class="nonce">Nonce: ${escapeHtml(req.nonce)}<br>
  <span class="meta">Verify this matches the nonce your agent displayed.</span></p>
  <p class="meta">Project: ${escapeHtml(req.projectRoot)}</p>
  <p class="reason">${escapeHtml(req.reason)}</p>
  <form method="post" action="/t/${opts.pathNonce}">
    <input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
${fields}    <p><input type="submit" value="Submit"></p>
  </form>
</main>
<script nonce="${opts.scriptNonce}">
  for (const btn of document.querySelectorAll('[data-reveal]')) {
    btn.addEventListener('click', function () {
      const input = document.getElementById(btn.getAttribute('data-reveal'));
      if (input === null) return;
      const showing = input.type === 'password';
      input.type = showing ? 'text' : 'password';
      btn.textContent = showing ? 'Hide' : 'Show';
    });
  }
  const form = document.querySelector('form');
  if (form !== null) {
    form.addEventListener('submit', function () {
      for (const btn of form.querySelectorAll('button')) btn.setAttribute('disabled', 'disabled');
    });
  }
</script>
</body>
</html>
`;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejected = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', () => {
      if (!rejected) {
        resolve(null);
      }
    });
  });
}

async function openBrowser(
  port: number,
  pathNonce: string,
): Promise<{ ok: boolean; url: string }> {
  const url = `http://127.0.0.1:${port}/t/${pathNonce}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve({ ok, url });
      }
    };
    setTimeout(() => finish(false), 5000).unref();
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' });
      child.once('error', () => finish(false));
      child.once('spawn', () => finish(true));
      child.once('exit', () => finish(true));
    } else if (process.platform === 'darwin') {
      execFile('open', [url], (err) => finish(err === null));
    } else {
      execFile('xdg-open', [url], (err) => finish(err === null));
    }
  });
}

export class LoopbackPrompter implements Prompter {
  readonly id: 'loopback-browser' = 'loopback-browser';

  private readonly options: LoopbackPrompterOptions;
  private openerProbe: Promise<boolean> | null = null;
  private current: { ticket: string; cancel: () => void } | null = null;

  constructor(options?: LoopbackPrompterOptions) {
    this.options = options ?? {};
  }

  available(): Promise<boolean> {
    if (this.openerProbe === null) {
      this.openerProbe = probeOpener();
    }
    return this.openerProbe;
  }

  async cancel(ticket: string): Promise<void> {
    if (this.current !== null && this.current.ticket === ticket) {
      this.current.cancel();
    }
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    return this.promptWithUrl(req);
  }

  async promptWithUrl(req: PromptRequest): Promise<LoopbackResult> {
    const pathNonce = randomBytes(16).toString('hex');
    const styleNonce = randomBytes(16).toString('base64');
    const scriptNonce = randomBytes(16).toString('base64');
    const csrf = randomBytes(16).toString('hex');

    let settled = false;
    let resolvePrompt: (value: LoopbackResult) => void = () => {};
    const promptPromise = new Promise<LoopbackResult>((resolve) => {
      resolvePrompt = resolve;
    });

    let launchedUrl: string | undefined;
    let complete: (results: PromptKeyResult[]) => void = () => {};
    let teardown: () => void = () => {};

    const sockets = new Set<Socket>();

    // Calculate expectedHost before creating server
    let expectedHost = '';

    const server: Server = createServer((incoming, outgoing) => {
      void serveRequest(
        incoming,
        outgoing,
        req,
        pathNonce,
        csrf,
        styleNonce,
        scriptNonce,
        complete,
        expectedHost,
      );
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, BIND_HOST, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('loopback server has no numeric address');
    }
    expectedHost = `${BIND_HOST}:${address.port}`;
    const fallbackUrl = `http://${expectedHost}/t/${pathNonce}`;
    this.options.onListening?.({ port: address.port, pathNonce, url: fallbackUrl });

    const finishPrompt = (results: PromptKeyResult[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      teardown();
      if (launchedUrl !== undefined) {
        resolvePrompt({ ticket: req.ticket, results, url: launchedUrl });
      } else {
        resolvePrompt({ ticket: req.ticket, results });
      }
    };
    complete = finishPrompt;

    teardown = (): void => {
      if (server.listening) {
        try {
          server.close();
        } catch {
          // already closed
        }
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    };

    const timeoutMs =
      Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? Math.floor(req.timeoutMs) : 120000;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      finishPrompt(req.keys.map((k) => ({ key: k.key, outcome: 'timeout' as const })));
    }, timeoutMs);
    timer.unref();

    this.current = {
      ticket: req.ticket,
      cancel: () => {
        this.current = null;
        finishPrompt(req.keys.map((k) => ({ key: k.key, outcome: 'cancelled' as const })));
      },
    };

    const launched =
      this.options.openBrowser === false
        ? { ok: false, url: fallbackUrl }
        : await openBrowser(address.port, pathNonce);
    launchedUrl = launched.ok ? undefined : launched.url;

    const result = await promptPromise;
    if (this.current !== null && this.current.ticket === req.ticket) {
      this.current = null;
    }
    return result;
  }
}

async function serveRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  req: PromptRequest,
  pathNonce: string,
  csrf: string,
  styleNonce: string,
  scriptNonce: string,
  complete: (results: PromptKeyResult[]) => void,
  expectedHost: string,
): Promise<void> {
  const secHeaders = securityHeaders(styleNonce, scriptNonce);

  if (incoming.headers.host !== expectedHost) {
    respondText(outgoing, 400, 'Bad Request', secHeaders);
    return;
  }

  // Origin must not CONTRADICT us; requiring its absence broke the real browser.
  //
  // Two facts, both learned by driving Chrome at this server rather than a test
  // client:
  //   1. Browsers send `Origin` on every POST, including same-origin ones.
  //   2. Because this page sets `Referrer-Policy: no-referrer`, the browser
  //      sends `Origin: null` rather than the page's actual origin.
  // The original rule ("any Origin header -> 400") therefore rejected the one
  // submission this entire surface exists to accept. Every unit test passed
  // because the HTTP client used in tests sends no Origin at all.
  //
  // Accepting only {absent, exact match, null} still refuses a genuine
  // cross-origin post, which would carry that other origin verbatim and cannot
  // forge this header. `null` is not a meaningful weakening: an attacker who
  // could induce it would still need the 128-bit path nonce and the ticket-bound
  // CSRF token, neither of which is readable cross-origin. Origin is
  // defence-in-depth here, not the primary control.
  const origin = incoming.headers.origin;
  const originOk =
    origin === undefined || origin === `http://${expectedHost}` || origin === 'null';
  if (!originOk) {
    respondText(outgoing, 400, 'Bad Request', secHeaders);
    return;
  }

  const requestUrl = new URL(incoming.url ?? '', `http://${expectedHost}`);
  const match = /^\/t\/([^/]*)$/.exec(requestUrl.pathname);
  if (match === null) {
    respondText(outgoing, 404, 'Not Found', secHeaders);
    return;
  }
  const candidate = match[1];
  if (candidate === undefined || !secureEqual(candidate, pathNonce)) {
    respondText(outgoing, 404, 'Not Found', secHeaders);
    return;
  }

  if (incoming.method === 'GET') {
    const rendered = renderForm(req, { pathNonce, csrf, styleNonce, scriptNonce });
    outgoing.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(rendered),
      Connection: 'close',
      ...secHeaders,
    });
    outgoing.end(rendered);
    return;
  }

  if (incoming.method !== 'POST') {
    respondText(outgoing, 405, 'Method Not Allowed', secHeaders);
    return;
  }

  const body = await readBody(incoming, MAX_BODY_BYTES);
  if (body === null) {
    return; // socket destroyed above the cap
  }
  const bodyText = body.toString('utf8');
  body.fill(0);
  const params = new URLSearchParams(bodyText);

  const submittedCsrf = params.get('csrf');
  if (submittedCsrf === null || !secureEqual(submittedCsrf, csrf)) {
    respondText(outgoing, 403, 'Forbidden', secHeaders);
    return;
  }

  const results: PromptKeyResult[] = [];
  for (const key of req.keys) {
    const skipped = params.get(SKIP_FIELD(key.key));
    if (skipped === '1') {
      results.push({ key: key.key, outcome: 'skipped' });
      continue;
    }
    const raw = params.get(VALUE_FIELD(key.key));
    if (raw !== null && raw.length > 0) {
      results.push({ key: key.key, outcome: 'entered', value: asSecret(Buffer.from(raw, 'utf8')) });
    } else {
      results.push({ key: key.key, outcome: 'skipped' });
    }
  }
  respondText(outgoing, 200, 'You can close this tab.', secHeaders);
  complete(results);
}

let openerProbeResult: Promise<boolean> | null = null;

function probeOpener(): Promise<boolean> {
  if (openerProbeResult !== null) {
    return openerProbeResult;
  }
  openerProbeResult = new Promise((resolve) => {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'exit', '0'], { stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('exit', () => resolve(true));
    } else if (process.platform === 'darwin') {
      execFile('open', ['--version'], (err) => resolve(err === null));
    } else {
      execFile('xdg-open', ['--version'], (err) => resolve(err === null));
    }
  });
  return openerProbeResult;
}
