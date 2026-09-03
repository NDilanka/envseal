import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findProjectRoot } from '@envseal/core';

/**
 * Argument handling for the `envseal-mcp` binary, kept out of bin.ts so it can
 * be tested without importing a module whose side effect is starting a server.
 */

/**
 * The shipped version, read from this package's own package.json so a release
 * can never ship a stale hardcoded string again (0.1.6 and 0.1.7 both
 * reported 0.1.5). Falls back to 'unknown' — never a wrong number.
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

export const USAGE = `envseal-mcp ${VERSION}

Serves the SEP/1 tools to an MCP host over stdio JSON-RPC.

Usage: envseal-mcp [--project <dir>]

Options:
  --project <dir>    Project root to broker secrets for. Default: search
                     upward from the current directory for env.schema.jsonc,
                     .git or package.json. If none is found, this server
                     refuses to start rather than create .envseal/ in a
                     directory that is not a project.
  --help, -h         Show this help and exit.
  --version, -v      Print the version and exit.

Transport: stdio only. --http and --port were removed; they were parsed and
then ignored, and no HTTP or SSE transport was ever implemented. For an HTTP
surface use @envseal/http-server, which speaks REST + OpenAPI on loopback --
that is a different protocol, not MCP over HTTP.
`;

export type ParsedArgv =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'serve'; project: string | undefined }
  | { kind: 'usage-error'; message: string };

export function parseArgv(args: string[]): ParsedArgv {
  let project: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      return { kind: 'help' };
    }
    if (arg === '--version' || arg === '-v') {
      return { kind: 'version' };
    }

    if (arg === '--project' || arg.startsWith('--project=')) {
      let value: string | undefined;
      if (arg.startsWith('--project=')) {
        value = arg.slice('--project='.length);
      } else {
        value = args[i + 1];
        i++;
      }
      if (value === undefined || value === '' || value.startsWith('-')) {
        return { kind: 'usage-error', message: '--project needs a directory' };
      }
      project = value;
      continue;
    }

    // Unknown arguments used to be ignored silently, which is how --http and
    // --port sat in the parser doing nothing while the README advertised
    // "stdio + streamable HTTP".
    if (arg === '--http' || arg === '--port' || arg.startsWith('--port=')) {
      const flag = arg.startsWith('--port=') ? '--port' : arg;
      return {
        kind: 'usage-error',
        message: `${flag} was removed: this server has only ever spoken stdio`,
      };
    }
    return { kind: 'usage-error', message: `unknown argument: ${arg}` };
  }

  return { kind: 'serve', project };
}

/**
 * findProjectRoot() falls back to its starting directory when it finds no
 * marker, and the Broker constructor eagerly writes .envseal/salt. Together
 * that meant an MCP host launching this server with a cwd the user did not
 * choose scattered .envseal/ directories around the filesystem and silently
 * brokered for the wrong project. Detect the fallback and refuse.
 */
export function resolveProjectRoot(
  project: string | undefined,
  cwd: string,
): { root: string } | { error: string } {
  if (project !== undefined) {
    const root = resolve(project);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { error: `--project ${root} is not an existing directory` };
    }
    return { root };
  }

  const root = findProjectRoot(cwd);
  const hasMarker =
    existsSync(join(root, 'env.schema.jsonc')) ||
    existsSync(join(root, '.git')) ||
    existsSync(join(root, 'package.json'));
  if (!hasMarker) {
    return {
      error:
        `no project found from ${cwd}.\n` +
        '  Looked for env.schema.jsonc, .git or package.json there and in every parent.\n' +
        '  Refusing to create .envseal/ in a directory that is not a project.\n' +
        '  Pass --project <dir> to name the project explicitly.',
    };
  }
  return { root };
}
