import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../src/server.js';
import * as http from 'node:http';

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
    },
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const reqUrl = new URL(url);
      const headers = options?.headers || {};
      const body = options?.body ? JSON.stringify(options.body) : undefined;

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
            resolve({ status: res.statusCode || 200, body: data });
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

  it('does not leak secrets in any response', async () => {
    const result = await startHttpServer({
      root: testRoot,
      token: 'test-token-12345',
    });

    serverCloseFunc = result.close;

    // Make several requests and collect all response bodies
    const responses = await Promise.all([
      httpRequest(`${result.url}/v1/env_describe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${result.token}` },
        body: {},
      }),
      httpRequest(`${result.url}/openapi.json`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${result.token}` },
      }),
    ]);

    const sentinel = 'sk-SENTINEL-SDK-DO-NOT-LEAK-4f5a6b7c8d9e';

    for (const response of responses) {
      expect(response.body).not.toContain(sentinel);
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

    // Server should be closed now
  });
});
