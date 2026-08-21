import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../src/server.js';
import type { Prompter, PromptRequest, PromptResponse } from '@envseal/prompters';
import { secretFromUtf8 } from '@envseal/protocol';
import * as http from 'node:http';

/**
 * A prompter that answers confirmations without any UI. Without it the server
 * falls back to selectPrompter(), which off CI resolves to loopback-browser —
 * so the env_use / env_verify exchanges below would open a real listener and
 * wait for a browser that never comes.
 *
 * The env_use confirmation is approved so the child actually runs and its
 * stdout (which echoes the sentinel) must come back redacted — the strongest
 * leak assertion in this file. Everything else is denied with an empty box,
 * which keeps env_verify fail-closed against its non-allowlisted host with no
 * network call at all.
 */
function hermeticPrompter(): Prompter {
  return {
    id: 'ide',
    available: async () => true,
    prompt: async (req: PromptRequest): Promise<PromptResponse> => ({
      ticket: req.ticket,
      results: req.keys.map((k) => ({
        key: k.key,
        outcome: 'entered' as const,
        value: secretFromUtf8(k.key === 'APPROVE' ? 'yes' : ''),
      })),
    }),
    cancel: async () => {
      /* nothing to tear down */
    },
  };
}

describe('HTTP Server Contract', () => {
  let serverCloseFunc: (() => Promise<void>) | null = null;

  // A throwaway project root. Passing process.cwd() points the broker at this
  // repository, so the suite writes a manifest and a .env into the source tree.
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'envseal-http-'));
    writeFileSync(join(testRoot, '.gitignore'), '.env\n', 'utf8');
  });

  afterEach(async () => {
    if (serverCloseFunc) {
      await serverCloseFunc();
      serverCloseFunc = null;
    }
    rmSync(testRoot, { recursive: true, force: true });
  });

  function httpRequest(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      rawBody?: string;
    },
  ): Promise<{ status: number; body: string; rawHeaders: string }> {
    return new Promise((resolve, reject) => {
      const reqUrl = new URL(url);
      const headers = options?.headers || {};
      const body =
        options?.rawBody ?? (options?.body ? JSON.stringify(options.body) : undefined);

      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body).toString();
      }

      const req = http.request(
        {
          hostname: reqUrl.hostname,
          port: reqUrl.port,
          path: reqUrl.pathname + reqUrl.search,
          method: options?.method || 'GET',
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode || 200,
              body: data,
              // Response headers are an egress channel too: a naive handler can
              // reflect a request header (including a credential) back out.
              rawHeaders: res.rawHeaders.join('\n'),
            });
          });
        },
      );

      req.on('error', reject);

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  it('starts server on ephemeral port', async () => {
    const result = await startHttpServer({
      root: testRoot,
    });

    expect(result.url).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    expect(result.token).toBeTruthy();
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);

    serverCloseFunc = result.close;
  });

  it('rejects requests without Authorization header', async () => {
    const result = await startHttpServer({
      root: testRoot,
      token: 'test-token-12345',
    });

    serverCloseFunc = result.close;

    const response = await httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: {},
      body: {},
    });

    expect(response.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const result = await startHttpServer({
      root: testRoot,
      token: 'correct-token-12345',
    });

    serverCloseFunc = result.close;

    const response = await httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-token',
      },
      body: {},
    });

    expect(response.status).toBe(401);
  });

  it('rejects requests with invalid Host header', async () => {
    const result = await startHttpServer({
      root: testRoot,
      token: 'test-token-12345',
    });

    serverCloseFunc = result.close;

    const response = await httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${result.token}`,
        Host: 'evil.local',
      },
      body: {},
    });

    expect(response.status).toBe(400);
  });

  it('rejects requests with Origin header', async () => {
    const result = await startHttpServer({
      root: testRoot,
      token: 'test-token-12345',
    });

    serverCloseFunc = result.close;

    const response = await httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${result.token}`,
        Origin: 'https://attacker.example',
      },
      body: {},
    });

    expect(response.status).toBe(400);
  });

  it('returns 200 for valid env_describe request', async () => {
    const result = await startHttpServer({
      root: testRoot,
      token: 'test-token-12345',
    });

    serverCloseFunc = result.close;

    const response = await httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${result.token}`,
      },
      body: {},
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('entries');
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('serves OpenAPI document at GET /openapi.json', async () => {
    const result = await startHttpServer({
      root: testRoot,
      token: 'test-token-12345',
    });

    serverCloseFunc = result.close;

    const response = await httpRequest(`${result.url}/openapi.json`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${result.token}`,
      },
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths).toBeDefined();

    // Check all 7 tools are present
    const toolPaths = Object.keys(body.paths || {});
    expect(toolPaths).toContain('/v1/env_describe');
    expect(toolPaths).toContain('/v1/env_declare');
    expect(toolPaths).toContain('/v1/env_request');
    expect(toolPaths).toContain('/v1/env_await');
    expect(toolPaths).toContain('/v1/env_verify');
    expect(toolPaths).toContain('/v1/env_use');
    expect(toolPaths).toContain('/v1/env_revoke');
  });

  // The previous version of this test declared a sentinel that was never stored
  // anywhere, then asserted two responses did not contain it. With no value in
  // the project it could not have failed for any implementation, correct or not
  // (VERIFICATION.md U10). This version provisions the value first and asserts
  // the fixture really is provisioned before making the leak claim.
  it('does not leak a provisioned secret in any response body or header', async () => {
    const sentinel = 'sk-U10SENTINEL-http-3b7d41f9e2c85a06';

    // Provision the value into the dotenv sink — exactly the state the broker
    // leaves behind after a completed env_request. startHttpServer takes no
    // prompter, so this is the only way to get a real value into the project.
    writeFileSync(join(testRoot, '.env'), `OPENAI_API_KEY=${sentinel}\n`, 'utf8');
    writeFileSync(
      join(testRoot, 'env.schema.jsonc'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'OPENAI_API_KEY',
            description: 'U10 leak-test fixture',
            required: true,
            secret: true,
            sink: 'dotenv',
            format: { pattern: '^sk-' },
            verify: {
              // A deliberately non-allowlisted host, so env_verify exercises
              // its response path and fails closed without any network call.
              method: 'GET',
              url: 'https://leak-probe.invalid/v1/check',
              headerTemplate: { Authorization: 'Bearer {{value}}' },
              expectStatus: [200],
            },
          },
        ],
      }),
      'utf8',
    );

    const result = await startHttpServer({
      root: testRoot,
      token: 'test-token-12345',
      prompter: hermeticPrompter(),
    });
    serverCloseFunc = result.close;
    const auth = { Authorization: `Bearer ${result.token}` };
    const post = (path: string, body: unknown) =>
      httpRequest(`${result.url}${path}`, { method: 'POST', headers: auth, body });

    // GUARD: if the fixture is not actually provisioned, every assertion below
    // is vacuous. Fail loudly here rather than passing for the wrong reason.
    const described = await post('/v1/env_describe', {});
    expect(described.status).toBe(200);
    const entry = (JSON.parse(described.body).entries as Array<{ key: string; present: boolean }>).find(
      (e) => e.key === 'OPENAI_API_KEY',
    );
    expect(entry, 'fixture must declare OPENAI_API_KEY').toBeDefined();
    expect(entry?.present, 'fixture secret must be present, or this test asserts nothing').toBe(true);

    const responses: Array<{ label: string; body: string; rawHeaders: string }> = [];
    const record = async (label: string, p: Promise<{ body: string; rawHeaders: string }>) => {
      responses.push({ label, ...(await p) });
    };

    await record('env_describe', Promise.resolve(described));
    await record('env_declare', post('/v1/env_declare', {
      entries: [{ key: 'SECOND_KEY', description: 'u10', required: true, secret: true }],
    }));
    // Reads the stored value and substitutes it into a probe header.
    await record('env_verify', post('/v1/env_verify', { keys: ['OPENAI_API_KEY'] }));
    // Reads the stored value and injects it into a child environment.
    await record('env_use', post('/v1/env_use', {
      keys: ['OPENAI_API_KEY'],
      command: [process.execPath, '-e', 'console.log(process.env.OPENAI_API_KEY)'],
    }));
    await record('openapi', httpRequest(`${result.url}/openapi.json`, { method: 'GET', headers: auth }));

    // Error branches: these are where an unfiltered internal string escapes.
    await record('bad token equal to the secret', httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sentinel}` },
      body: {},
    }));
    await record('malformed JSON body', httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: auth,
      rawBody: '{not json',
    }));
    await record('body is the raw secret', httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: auth,
      rawBody: sentinel,
    }));
    await record('oversized body', httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: auth,
      rawBody: `{"scope":"${'x'.repeat(1024 * 1024 + 64)}"}`,
    }));
    await record('schema violation', post('/v1/env_declare', {
      entries: [{ key: 123, description: sentinel }],
    }));
    await record('unknown operation', post('/v1/env_nope', {}));
    // Removes the value; run last so every route above saw it present.
    await record('env_revoke', post('/v1/env_revoke', { keys: ['OPENAI_API_KEY'] }));

    expect(responses.length).toBe(12);
    for (const response of responses) {
      expect(response.body, `secret leaked in ${response.label} body`).not.toContain(sentinel);
      expect(response.rawHeaders, `secret leaked in ${response.label} headers`).not.toContain(sentinel);
    }
  });

  it('closes cleanly without hanging', async () => {
    const result = await startHttpServer({
      root: testRoot,
      token: 'test-token-12345',
    });

    serverCloseFunc = result.close;

    // Make a request
    await httpRequest(`${result.url}/v1/env_describe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.token}` },
      body: {},
    });

    // Close the server
    await result.close();
    serverCloseFunc = null;

    // The port must actually be released. Without this the test contained no
    // assertion at all: only an outright throw or a vitest timeout could fail
    // it, so a close that left the listener bound passed as success.
    await expect(
      httpRequest(`${result.url}/v1/env_describe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${result.token}` },
        body: {},
      }),
    ).rejects.toThrow();
  });
});
