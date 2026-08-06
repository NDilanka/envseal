import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { request } from 'undici';
import { LoopbackPrompter } from '../src/loopback.js';
import type { LoopbackResult } from '../src/loopback.js';
import type { PromptRequest } from '../src/types.js';

// The opener (`open` / `start` / `xdg-open`) must not launch anything during
// tests. Mock it to fail fast; the loopback URL it is invoked with is captured
// here so the test can drive the real server.
const captured = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const module = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');

  const recordUrl = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('http://')) {
      captured.urls.push(value);
    }
  };

  const fakeSpawn = (...args: unknown[]): unknown => {
    for (const arg of args) {
      if (Array.isArray(arg)) {
        for (const item of arg) recordUrl(item);
      } else {
        recordUrl(arg);
      }
    }
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('opener disabled in tests')));
    return child;
  };

  const fakeExecFile = (file: string, args: unknown, callback?: unknown): void => {
    recordUrl(file);
    if (Array.isArray(args)) {
      for (const item of args) recordUrl(item);
    }
    if (typeof callback === 'function') {
      (callback as (err: Error) => void)(new Error('opener disabled in tests'));
    }
  };

  return { ...module, spawn: vi.fn(fakeSpawn), execFile: vi.fn(fakeExecFile) };
});

const DISPLAY_NONCE = '7F2A-91C4';

function makeRequest(overrides: Partial<PromptRequest> = {}): PromptRequest {
  return {
    ticket: `tkt_${Math.random().toString(36).slice(2)}`,
    nonce: DISPLAY_NONCE,
    projectRoot: '/tmp/envseal-test',
    reason: 'A test needs an API key',
    keys: [{ key: 'OPENAI_API_KEY', description: 'OpenAI API key for the test' }],
    timeoutMs: 5000,
    ...overrides,
  };
}

let toCleanup: { prompter: LoopbackPrompter; ticket: string } | null = null;

beforeEach(() => {
  captured.urls = [];
});

afterEach(async () => {
  if (toCleanup !== null) {
    await toCleanup.prompter.cancel(toCleanup.ticket);
    toCleanup = null;
  }
});

async function capturedUrl(): Promise<URL> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const latest = captured.urls.at(-1);
    if (latest !== undefined) {
      return new URL(latest);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('loopback opener was never invoked');
}

async function startPrompt(
  prompter: LoopbackPrompter,
  overrides: Partial<PromptRequest> = {},
): Promise<{ result: Promise<LoopbackResult>; url: URL; ticket: string }> {
  const req = makeRequest(overrides);
  const result = prompter.promptWithUrl(req);
  const url = await capturedUrl();
  toCleanup = { prompter, ticket: req.ticket };
  return { result, url, ticket: req.ticket };
}

async function fetchPage(url: URL): Promise<string> {
  const res = await request(url.href);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/html');
  return res.body.text();
}

function parseCsrf(html: string): string {
  const match = /name="csrf" value="([^"]*)"/.exec(html);
  if (match === null) {
    throw new Error('csrf token not found in the rendered page');
  }
  return match[1];
}

function postForm(
  url: URL,
  body: Record<string, string>,
): Promise<Awaited<ReturnType<typeof request>>> {
  const params = new URLSearchParams(body).toString();
  return request(url.href, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'content-length': String(Buffer.byteLength(params)),
    },
    body: params,
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const onOpen = (): void => {
      socket.destroy();
      resolve(true);
    };
    socket.once('connect', onOpen);
    socket.once('error', () => resolve(false));
  });
}

async function expectPortClosed(port: number, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!(await canConnect(port))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('loopback listener is still accepting connections');
}

describe('loopback-browser prompter', () => {
  it('rejects a wrong path nonce with 404', async () => {
    const result = await startPrompt(new LoopbackPrompter());
    try {
      const res = await request(`${result.url.origin}/t/${'0'.repeat(32)}`);
      expect(res.statusCode).toBe(404);
      expect(await res.body.text()).toBe('Not Found');
    } finally {
      await toCleanup?.prompter.cancel(toCleanup.ticket);
    }
    await result.result;
    await expectPortClosed(Number(result.url.port), 1000);
  });

  it('rejects a mismatched Host header with 400', async () => {
    const result = await startPrompt(new LoopbackPrompter());
    try {
      const res = await request(result.url.href, { headers: { host: 'evil.local' } });
      expect(res.statusCode).toBe(400);
      expect(await res.body.text()).toBe('Bad Request');
    } finally {
      await toCleanup?.prompter.cancel(toCleanup.ticket);
    }
    await result.result;
    await expectPortClosed(Number(result.url.port), 1000);
  });

  it('rejects any Origin header with 400', async () => {
    const result = await startPrompt(new LoopbackPrompter());
    try {
      const res = await request(result.url.href, { headers: { origin: 'https://evil.local' } });
      expect(res.statusCode).toBe(400);
      expect(await res.body.text()).toBe('Bad Request');
    } finally {
      await toCleanup?.prompter.cancel(toCleanup.ticket);
    }
    await result.result;
    await expectPortClosed(Number(result.url.port), 1000);
  });

  it('serves the form with the display nonce and an escaped reason', async () => {
    const result = await startPrompt(new LoopbackPrompter(), {
      reason: 'Test with <script>alert(1)</script> injection',
    });
    try {
      const html = await fetchPage(result.url);
      expect(html).toContain('7F2A-91C4');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('Project: /tmp/envseal-test');
    } finally {
      await toCleanup?.prompter.cancel(toCleanup.ticket);
    }
    await result.result;
    await expectPortClosed(Number(result.url.port), 1000);
  });

  it('resolves on a valid POST and closes the listener within 500ms', async () => {
    const result = await startPrompt(new LoopbackPrompter());
    try {
      const html = await fetchPage(result.url);
      const csrf = parseCsrf(html);
      const res = await postForm(result.url, { csrf, 'env_value.OPENAI_API_KEY': 'test-key' });
      expect(res.statusCode).toBe(200);
    } finally {
      // Don't call cancel here; the successful POST should resolve the prompt
    }
    const outcome = await result.result;
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ key: 'OPENAI_API_KEY', outcome: 'entered' });
    await expectPortClosed(Number(result.url.port), 500);
  });

  it('rejects a POST with the wrong CSRF with 403', async () => {
    const result = await startPrompt(new LoopbackPrompter());
    try {
      const res = await postForm(result.url, { csrf: 'wrongcsrf', 'env_value.OPENAI_API_KEY': 'test' });
      expect(res.statusCode).toBe(403);
      expect(await res.body.text()).toBe('Forbidden');
    } finally {
      await toCleanup?.prompter.cancel(toCleanup.ticket);
    }
    await result.result;
    await expectPortClosed(Number(result.url.port), 1000);
  });

  it('resolves with timeout when the deadline expires', async () => {
    const result = await startPrompt(new LoopbackPrompter(), { timeoutMs: 100 });
    // Don't make any requests, just wait for timeout
    const outcome = await result.result;
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ key: 'OPENAI_API_KEY', outcome: 'timeout' });
    await expectPortClosed(Number(result.url.port), 1000);
  });
});
