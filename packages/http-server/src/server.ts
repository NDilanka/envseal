import * as node_http from 'node:http';
import * as node_crypto from 'node:crypto';
import * as node_fs from 'node:fs';
import * as node_os from 'node:os';
import * as node_path from 'node:path';
import { Broker } from '@envseal/core';
import { createProbeApproval, createUseConfirm, dispatch, isSepToolName } from '@envseal/sdk';
import type { Prompter } from '@envseal/prompters';
import { selectPrompter } from '@envseal/prompters';
import { generateOpenAPI } from './openapi.js';

export interface HttpServerOptions {
  root: string;
  port?: number;
  token?: string;
  /**
   * Surface used to ask the user for env_use confirmation and for consent
   * before a non-allowlisted verify probe. Defaults to selectPrompter(), which
   * resolves to `none` in CI -- there those two operations fail with
   * SEP_NO_INTERACTIVE_SURFACE rather than running unattended.
   */
  prompter?: Prompter;
}

interface StartResult {
  url: string;
  token: string;
  close(): Promise<void>;
}

async function getOrCreateToken(token?: string): Promise<string> {
  if (token) {
    return token;
  }

  const tokenDir = node_path.join(node_os.homedir(), '.envseal');
  const tokenFile = node_path.join(tokenDir, 'api-token');

  // Create directory if needed
  if (!node_fs.existsSync(tokenDir)) {
    node_fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  }

  // Check if token file exists
  if (node_fs.existsSync(tokenFile)) {
    const tokenBuf = node_fs.readFileSync(tokenFile);
    return tokenBuf.toString('utf8').trim();
  }

  // Generate new token (32 random bytes as hex)
  const randomBytes = node_crypto.randomBytes(32);
  const newToken = randomBytes.toString('hex');

  // Write with 0o600 permissions
  node_fs.writeFileSync(tokenFile, newToken, { mode: 0o600 });

  return newToken;
}

/**
 * Constant-time bearer token check. Shared by the /v1 route auth and the
 * /openapi.json route (N5): the spec used to be served BEFORE the auth check,
 * so any loopback process could read the API surface without the token.
 */
function bearerTokenMatches(authorization: string | undefined, token: string): boolean {
  const authHeader = authorization ?? '';
  const bearerPrefix = 'Bearer ';

  if (!authHeader.startsWith(bearerPrefix)) {
    return false;
  }

  const providedToken = authHeader.slice(bearerPrefix.length);

  // Use timing-safe comparison
  const expectedTokenBuf = Buffer.from(token, 'utf8');
  const providedTokenBuf = Buffer.from(providedToken, 'utf8');

  try {
    return (
      expectedTokenBuf.length === providedTokenBuf.length &&
      node_crypto.timingSafeEqual(expectedTokenBuf, providedTokenBuf)
    );
  } catch {
    return false;
  }
}

export async function startHttpServer(
  opts: HttpServerOptions,
): Promise<StartResult> {
  const token = await getOrCreateToken(opts.token);

  const prompter = opts.prompter ?? (await selectPrompter());
  const surface = { projectRoot: opts.root, prompter: async (): Promise<Prompter> => prompter };
  const broker = new Broker({
    root: opts.root,
    prompter,
    // /v1/env_use is in the OpenAPI document. Without onConfirm the broker has
    // no way to ask anyone, and exec.ts reports the missing callback as "the
    // user denied the confirmation" for a user who was never asked.
    onConfirm: createUseConfirm(surface),
    // PLAN.md §6.4 probe consent, supplied by no binding before this.
    onApprovalNeeded: createProbeApproval(surface),
  });

  let server: node_http.Server | null = null;
  let actualPort = 0;

  const requestHandler = async (
    req: node_http.IncomingMessage,
    res: node_http.ServerResponse,
  ): Promise<void> => {
    // Common response headers
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/json');

    // Enforce Host header (DNS rebinding defense)
    const hostHeader = req.headers.host;
    const expectedHost = `127.0.0.1:${actualPort}`;
    if (hostHeader !== expectedHost) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: {
            code: 'INVALID_HOST',
            userMessage: 'Invalid Host header',
            retriable: false,
          },
        }),
      );
      return;
    }

    // Reject requests carrying an Origin header at all (CORS defense).
    //
    // Deliberately stricter than the loopback prompter, which must accept the
    // `Origin: null` a real browser sends on its own form post. Nothing here is
    // ever fetched by a browser page, so any Origin is a browser reaching a
    // surface it has no business on.
    //
    // `!== undefined`, not truthiness: `Origin:` with an empty value is a
    // present header, and the old check let it straight through (W3-06).
    if (req.headers.origin !== undefined) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: {
            code: 'INVALID_ORIGIN',
            userMessage: 'Origin header not allowed',
            retriable: false,
          },
        }),
      );
      return;
    }

    // Handle GET /openapi.json — authenticated like every other route (N5).
    // The document carries no secrets, but an unauthenticated read let any
    // loopback process fingerprint the deployment's full route table, and no
    // caller in this repository depends on the anonymous read.
    if (req.method === 'GET' && req.url === '/openapi.json') {
      if (!bearerTokenMatches(req.headers.authorization, token)) {
        res.writeHead(401);
        res.end(
          JSON.stringify({
            error: {
              code: 'UNAUTHORIZED',
              userMessage: 'Missing or invalid authorization',
              retriable: false,
            },
          }),
        );
        return;
      }
      const openapi = generateOpenAPI(actualPort);
      res.writeHead(200);
      res.end(JSON.stringify(openapi));
      return;
    }

    // All other routes require POST and Bearer token auth
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(
        JSON.stringify({
          error: {
            code: 'METHOD_NOT_ALLOWED',
            userMessage: 'Method not allowed',
            retriable: false,
          },
        }),
      );
      return;
    }

    // Check Authorization header
    const authHeader = req.headers.authorization ?? '';
    const bearerPrefix = 'Bearer ';

    if (!authHeader.startsWith(bearerPrefix)) {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            userMessage: 'Missing or invalid authorization',
            retriable: false,
          },
        }),
      );
      return;
    }

    if (!bearerTokenMatches(authHeader, token)) {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            userMessage: 'Invalid token',
            retriable: false,
          },
        }),
      );
      return;
    }

    // Parse URL to get operation name
    const urlPath = req.url ?? '/';
    const match = urlPath.match(/^\/v1\/([a-z_]+)$/);

    if (!match || !match[1]) {
      res.writeHead(404);
      res.end(
        JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            userMessage: 'Endpoint not found',
            retriable: false,
          },
        }),
      );
      return;
    }

    const operationName = match[1];

    // An unknown operation is a routing failure, not a result. It used to reach
    // dispatch(), which answered with an error body under HTTP 200 -- so a
    // client saw success for an endpoint that does not exist (F32). Checked
    // after auth so an unauthenticated caller cannot map the route table.
    if (!isSepToolName(operationName)) {
      res.writeHead(404);
      res.end(
        JSON.stringify({
          error: {
            code: 'SEP_UNKNOWN_KEY',
            userMessage: `Unknown operation: ${operationName}`,
            retriable: false,
          },
        }),
      );
      return;
    }

    // Read and validate body
    const chunks: Buffer[] = [];
    let bodySize = 0;
    const MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

    for await (const chunk of req) {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413);
        res.end(
          JSON.stringify({
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              userMessage: 'Request body too large',
              retriable: false,
            },
          }),
        );
        return;
      }
      chunks.push(chunk);
    }

    let body: unknown;
    try {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: {
            code: 'INVALID_JSON',
            userMessage: 'Invalid JSON in request body',
            retriable: false,
          },
        }),
      );
      return;
    }

    // Dispatch to SDK
    try {
      const result = await dispatch(broker, operationName, body);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            userMessage: 'An error occurred',
            retriable: false,
          },
        }),
      );
    }
  };

  return new Promise((resolve, reject) => {
    server = node_http.createServer(requestHandler);

    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      if (!server) {
        reject(new Error('Server not created'));
        return;
      }

      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not get server address'));
        return;
      }

      actualPort = addr.port;
      const url = `http://127.0.0.1:${actualPort}`;

      resolve({
        url,
        token,
        close: async (): Promise<void> => {
          return new Promise((closeResolve, closeReject) => {
            if (!server) {
              closeResolve();
              return;
            }
            server.close((err) => {
              if (err) {
                closeReject(err);
              } else {
                closeResolve();
              }
            });
          });
        },
      });
    });

    server.on('error', reject);
  });
}
