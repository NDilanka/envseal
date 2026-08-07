import { findProjectRoot, loadManifest, projectPaths } from '@envseal/core';
import { readPayload, writeResult } from './lib.js';

/**
 * §8.1 — Pre-tool-use hook.
 *
 * Blocks reads/edits/writes and Bash commands that would expose environment
 * secret values into the transcript. Fail-open: any internal error (missing
 * manifest, malformed command) returns allow.
 */

export interface ToolCall {
  tool: string;
  path?: string;
  command?: string;
}

export interface PreToolUseContext {
  /** Declared secret keys from the manifest, uppercased. */
  declaredSecrets?: string[];
}

export interface Decision {
  allow: boolean;
  reason?: string;
}

interface Payload {
  tool?: string;
  tool_name?: string;
  path?: string;
  command?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

export const HOOK_NAME = 'pre-tool-use';

/** Normalise both the spec shape and the real Claude Code pre_tool_use shape. */
export function normalizePayload(payload: unknown): ToolCall {
  const p = (payload ?? {}) as Payload;
  const tool = String(p.tool ?? p.tool_name ?? '');
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const path =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : typeof p.path === 'string'
          ? p.path
          : undefined;
  const command =
    typeof input.command === 'string'
      ? input.command
      : typeof p.command === 'string'
        ? p.command
        : undefined;
  return { tool, path, command };
}

const SECRET_VAR_RE = /\$\{?([A-Z][A-Z0-9_]{0,63})\}?/g;
const FILE_READERS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'strings',
  'xxd',
  'od',
  'type',
]);
const SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\||\(|\)|\n)\s*/;

export function isDeniedSecretPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? norm;

  if (base === '.env.example' || base === '.env.sample' || base === '.env.template') {
    return false;
  }
  if (base === 'env.schema.jsonc') {
    return false;
  }
  if (base === '.env') {
    return true;
  }
  if (/^\.env\..+/.test(base)) {
    return true;
  }
  if (base === 'credentials.json') {
    return true;
  }
  if (/^secrets\.(json|ya?ml|toml)$/i.test(base)) {
    return true;
  }
  if (/\.(pem|key)$/i.test(base)) {
    return true;
  }
  if (/^id_rsa/i.test(base)) {
    return true;
  }

  const segments = norm.split('/');
  if (
    segments.includes('.envseal') &&
    (segments[segments.length - 1] === 'salt' || segments[segments.length - 1] === 'approvals.json')
  ) {
    return true;
  }

  return false;
}

/**
 * Split a command into pipeline/boolean segments. Returns the head command of
 * each segment so `cd x && cat .env` exposes the same signal as `cat .env`.
 */
export function splitCommand(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT_RE)
    .filter((s) => s.trim() !== '');
}

export function stripAssignments(segment: string): string {
  let out = segment.trim();
  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]+|"[^"]*"|'[^']*')(\s+|$)/.exec(out);
    if (m === null) break;
    out = out.slice(m[0].length).trim();
  }
  return out;
}

export function headOf(segment: string): string {
  const stripped = stripAssignments(segment);
  const first = /^([^\s]+)/.exec(stripped);
  return first === null ? '' : first[1];
}

export function isSecretShapedPattern(pattern: string): boolean {
  if (pattern.length === 0) {
    return false;
  }
  if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AKIA|sk-|ghp_|glpat-|BEGIN [A-Z ]*PRIVATE KEY)/i.test(pattern)) {
    return true;
  }
  return false;
}

export function pathTokens(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((token) => token.replace(/^['"]+|['"]+$/g, ''))
    .filter((t) => t.length > 0)
    .map((token) => token.replace(/\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]*\}/g, '').replace(/^~/, ''));
}

export function echoReferencesSecret(segment: string, declared: Set<string>): string | null {
  if (!/\becho\b/.test(segment)) {
    return null;
  }
  SECRET_VAR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_VAR_RE.exec(segment)) !== null) {
    const name = match[1];
    if (name !== undefined && declared.has(name)) {
      return name;
    }
  }
  return null;
}

export function grepIsRecursive(segment: string): boolean {
  return /\b(?:grep|rg|ripgrep|ag)\b(?:\s+--?[A-Za-z]*[rR][A-Za-z]*\s*)+/.test(segment);
}

export function grepPattern(segment: string): string | null {
  const tokens = segment.split(/\s+/);
  let seenFlagWithArg = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.startsWith('-')) {
      if (token === '-e' || token === '--regexp' || token === '--include' || token === '--exclude' || token === '-f') {
        seenFlagWithArg = true;
        i++;
      }
      continue;
    }
    if (seenFlagWithArg) {
      seenFlagWithArg = false;
      continue;
    }
    return token;
  }
  return null;
}

export function decide(call: ToolCall, context?: PreToolUseContext): Decision {
  const declared = new Set(
    (context?.declaredSecrets ?? []).map((k) => k.toUpperCase()),
  );

  // --- File operations -----------------------------------------------------
  if (call.tool === 'Read' || call.tool === 'Edit' || call.tool === 'Write') {
    const path = call.path;
    if (path !== undefined && isDeniedSecretPath(path)) {
      const verb = call.tool === 'Read' ? 'reading' : call.tool === 'Edit' ? 'editing' : 'writing';
      return {
        allow: false,
        reason:
          `Blocked: ${verb} \`${path}\` would put its contents in the transcript. ` +
          'Use `env_describe` for status or `env_verify` to test the key.',
      };
    }
    return { allow: true };
  }

  // --- Bash commands -------------------------------------------------------
  if (call.tool === 'Bash') {
    if (call.command === undefined) {
      return { allow: true };
    }
    return decideBash(call.command, declared);
  }

  return { allow: true };
}

export function decideBash(command: string, declared: Set<string>): Decision {
  const commands = splitCommand(command);

  // Whole-command rules.
  if (/\bexport\s+(?:-\w+\s+)*-p\b/.test(command)) {
    return {
      allow: false,
      reason:
        'Blocked: `export -p` would print every environment variable. ' +
        'Use `env_describe` to check which keys are present.',
    };
  }

  for (const rawSegment of commands) {
    const segment = stripAssignments(rawSegment);
    const head = headOf(segment);

    if (head === 'printenv') {
      return {
        allow: false,
        reason:
          'Blocked: `printenv` would expose environment variables. ' +
          'Use `/env:status` to check provisioning state.',
      };
    }

    if (head === 'env') {
      // `env` is only safe when it runs an explicit command: env FOO=1 npm test.
      if (envIsBare(segment)) {
        return {
          allow: false,
          reason:
            'Blocked: `env` would expose environment variables. ' +
            'Use `/env:status` to check provisioning state.',
        };
      }
    }

    if (head === 'set' && segment.split(/\s+/).length === 1) {
      return {
        allow: false,
        reason:
          'Blocked: `set` with no arguments would print the shell environment. ' +
          'Use `env_describe` to list declared keys instead.',
      };
    }

    if (FILE_READERS.has(head)) {
      const tokens = pathTokens(segment);
      const denied = tokens.find((t) => isDeniedSecretPath(t));
      if (denied !== undefined) {
        return {
          allow: false,
          reason:
            `Blocked: \`${head}\` on secret path \`${denied}\` would put its contents in the transcript. ` +
            'Use `env_describe` for status or `env_verify` to test the key.',
        };
      }
    }

    if (head === 'echo') {
      const exposed = echoReferencesSecret(segment, declared);
      if (exposed !== null) {
        return {
          allow: false,
          reason:
            `Blocked: \`echo $${exposed}\` would put a secret value in the transcript. ` +
            `Store it with \`/env:set ${exposed}\` and inject it via \`env_use\` if a command needs it.`,
        };
      }
    }

    if (grepIsRecursive(segment)) {
      const pattern = grepPattern(segment);
      if (pattern !== null && isSecretShapedPattern(pattern)) {
        return {
          allow: false,
          reason:
            'Blocked: recursive `grep` with a secret-shaped pattern could match credential values. ' +
            'Use `/env:doctor` to audit provisioning health instead.',
        };
      }
    }
  }

  return { allow: true };
}

/** True when `env` is being used to LIST, not to run a command. */
export function envIsBare(segment: string): boolean {
  const tokens = segment.split(/\s+/);
  if (tokens[0] !== 'env') {
    return false;
  }
  let i = 1;
  while (i < tokens.length && /^-[A-Za-z]/.test(tokens[i] ?? '')) {
    i++;
  }
  // Remaining tokens: assignments then a command. If nothing left, it lists.
  let sawCommand = false;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      sawCommand = true;
    }
    i++;
  }
  return !sawCommand;
}

export function loadDeclaredSecrets(root: string): string[] {
  try {
    const manifest = loadManifest(projectPaths(root));
    if (manifest === null) {
      return [];
    }
    return manifest.entries.filter((entry) => entry.secret !== false).map((entry) => entry.key);
  } catch {
    return [];
  }
}

export function run(): Promise<void> {
  return readPayload<Payload>()
    .then((payload) => {
      const call = normalizePayload(payload);
      const root = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
      const declaredSecrets = loadDeclaredSecrets(findProjectRoot(root));
      const decision = decide(call, { declaredSecrets });
      return {
        ...decision,
        // Real Claude Code pre_tool_use contract (spec output carried too).
        permissionDecision: decision.allow ? 'allow' : 'deny',
        denyReason: decision.reason,
      };
    })
    .then((result) => {
      writeResult(result);
    });
}

if (process.argv[1] !== undefined) {
  const isMain = /pre-tool-use(?:\.cjs|\.js|\.ts)?$/.test(process.argv[1]);
  if (isMain) {
    run().catch((error: unknown) => {
      // Fail open: an internal error must not block tool use.
      const fallback = {
        allow: true,
        permissionDecision: 'allow',
        denyReason: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
      writeResult(fallback);
    });
  }
}
