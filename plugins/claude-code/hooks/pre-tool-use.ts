import { findProjectRoot, loadManifest, projectPaths } from '@envseal/core';
import { detect } from '@envseal/detector';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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
  /** Working directory for resolving relative file paths (hook payload cwd). */
  cwd?: string;
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
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
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
  // W3-07: sed/awk/grep read files just as `cat` does, but were absent from
  // this list — so `sed -n 1p <envfile>` and `printf '%s' "$(sed -n 1p
  // <envfile>)"` sailed through while the `cat` form was blocked.
  'sed',
  'awk',
  'grep',
  // Same class, same reasoning: rg is the modern grep (agents reach for it
  // constantly), bat and nl are cat-alikes. Denied only when an argument
  // references a denied secret path — `rg TODO src` is unaffected.
  'rg',
  'bat',
  'nl',
  // H1: bash builtins that execute a file in the current shell — same leak
  // class as `cat` when the operand is a secret path.
  'source',
  '.',
]);
/** S2: nested `sh -c` / `bash -c` payloads beyond this depth are denied. */
export const MAX_PAYLOAD_DEPTH = 3;
const SHELL_INVOKERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
const WRAPPERS = new Set([
  'sudo',
  'command',
  'exec',
  'builtin',
  'nice',
  'nohup',
  'xargs',
  'env',
  // H3: busybox multiplexes applets — `busybox cat .env` is still a read.
  'busybox',
  'busybox.exe',
]);
// W3-07: backticks are command substitution too. Without splitting on them,
// `echo "`cat <envfile>`"` was one segment whose head is `echo` — the inner
// reader never got a segment of its own to be checked against.
const SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\||\(|\)|\n|`)\s*/;
/** Tools that name a file to read or mutate. Kept in sync with the PreToolUse
 *  matcher in hooks/hooks.json — a tool listed in one and not the other is a
 *  hole in the guard. plugin-contract.test.ts reads this list to assert that
 *  sync, so it must stay exported. */
export const FILE_TOOLS_FOR_TEST: readonly string[] = [
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
];
const FILE_TOOLS = new Set(FILE_TOOLS_FOR_TEST);

export function isDeniedSecretPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? norm;

  if (base === '.env.example' || base === '.env.sample' || base === '.env.template') {
    return false;
  }
  if (base === 'env.schema.jsonc') {
    return false;
  }
  // Glob audit: `.env*` must be treated as possibly-.env, not as a literal
  // name that matches nothing. If the glob-stripped form could resolve to a
  // denied name, deny — a read that MIGHT hit a secret file must not pass
  // silently just because the model wrote a wildcard.
  if (/[*?[]/.test(base)) {
    const globless = base.replace(/[*?[\]]/g, '');
    const deniedNames = ['.env', 'credentials.json', 'id_rsa'];
    if (
      deniedNames.some((n) => n.startsWith(globless) || globless.startsWith(n)) ||
      /^\.env\..+/.test(globless) ||
      /^secrets\.[a-z0-9]*$/i.test(globless) ||
      /\.(pem|key)$/i.test(globless)
    ) {
      return true;
    }
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

/** H5: manifest reads are allowed, but not when comments hold secret-shaped text. */
export function isEnvSchemaJsoncPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? norm;
  return base === 'env.schema.jsonc';
}

export const ENV_SCHEMA_SECRET_DENY_REASON =
  'Blocked: env.schema.jsonc contains secret-shaped text. Remove it from the file (including comments); store values with envseal, not in the manifest.';

function resolveFilePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

/** Scan on-disk manifest text; fail-open when the file is missing or unreadable. */
export function envSchemaJsoncHasHighConfidenceSecret(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) {
      return false;
    }
    const text = readFileSync(filePath, 'utf8');
    return detect(text).some((d) => d.confidence === 'high');
  } catch {
    return false;
  }
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

/** H2: after `env`, skip flags (-i, -u VAR, -C DIR, --…) before the command. */
export function stripEnvInvocationPrefix(rest: string): string {
  let out = rest.trim();
  for (;;) {
    out = stripAssignments(out);
    const next = /^([^\s]+)/.exec(out);
    if (next === null) {
      return '';
    }
    const token = next[1]!.replace(/^["']|["']$/g, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      out = out.slice(next[0].length).trim();
      continue;
    }
    if (token.startsWith('--')) {
      out = out.slice(next[0].length).trim();
      if (!token.includes('=') && /^(?:--unset|--chdir|--split-string)$/.test(token)) {
        const arg = /^([^\s]+)/.exec(out);
        if (arg !== null) {
          out = out.slice(arg[0].length).trim();
        }
      }
      continue;
    }
    if (/^-[A-Za-z]/.test(token)) {
      out = out.slice(next[0].length).trim();
      if (/^-(?:u|C|S)$/.test(token)) {
        const arg = /^([^\s]+)/.exec(out);
        if (arg !== null) {
          out = out.slice(arg[0].length).trim();
        }
      }
      continue;
    }
    break;
  }
  return out;
}

export function headOf(segment: string): string {
  const stripped = stripAssignments(segment);
  const first = /^([^\s]+)/.exec(stripped);
  let head = first?.[1] ?? '';
  // Wrapper audit: `sudo cat .env`, `command cat .env`, `xargs cat .env`,
  // `env FOO=1 cat .env` all execute the reader through a transparent
  // wrapper. Strip known wrappers — but ONLY when another word follows, so a
  // bare `env` stays `env` and its own dump check (envIsBare) still fires —
  // then resolve any remaining path prefix to its basename so `/bin/cat
  // .env` matches the same way bare `cat .env` does. Wrapper FLAGS (e.g.
  // `sudo -u root`) end the unwrapping; the denylist stays a heuristic layer,
  // not a shell parser. H2: `env -i cat .env` strips env flags before the
  // inner command head is resolved.
  for (;;) {
    const bare = head.replace(/^["']|["']$/g, '');
    if (!WRAPPERS.has(bare)) {
      break;
    }
    let rest = stripped.slice(stripped.indexOf(bare) + bare.length).trim();
    if (bare === 'env') {
      rest = stripEnvInvocationPrefix(rest);
    } else {
      rest = stripAssignments(rest);
    }
    const next = /^([^\s]+)/.exec(rest);
    if (next === null) {
      break; // bare wrapper word: leave it for its own checks
    }
    head = next[1]!;
  }
  return head.split('/').pop() ?? head;
}

/** Read one shell argument (quoted or bare word) from the front of `s`. */
export function readShellArgument(s: string): { value: string; rest: string } | null {
  const trimmed = s.trimStart();
  if (trimmed === '') {
    return null;
  }
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let i = 1;
    let raw = '';
    while (i < trimmed.length) {
      if (trimmed[i] === '\\' && quote === '"') {
        if (i + 1 < trimmed.length) {
          raw += trimmed[i + 1];
          i += 2;
          continue;
        }
      }
      if (trimmed[i] === quote) {
        return { value: raw, rest: trimmed.slice(i + 1) };
      }
      raw += trimmed[i]!;
      i++;
    }
    return { value: raw, rest: '' };
  }
  const word = /^(\S+)/.exec(trimmed);
  if (word === null) {
    return null;
  }
  return { value: word[1]!, rest: trimmed.slice(word[0].length) };
}

/** Extract the script argument from `sh -c '…'` / `bash -c "…"`. */
export function extractShellPayload(segment: string): string | null {
  const stripped = stripAssignments(segment.trim());
  const first = /^([^\s]+)/.exec(stripped);
  if (first === null) {
    return null;
  }
  const head = first[1]!.replace(/^["']|["']$/g, '').split('/').pop() ?? '';
  if (!SHELL_INVOKERS.has(head)) {
    return null;
  }
  let rest = stripped.slice(first[0].length).trim();
  while (rest !== '') {
    const flag = /^(-[^\s=]+(?:=[^\s]+)?|--[^\s=]+(?:=[^\s]+)?)\s*/.exec(rest);
    if (flag === null) {
      break;
    }
    const flagToken = flag[1]!;
    rest = rest.slice(flag[0].length);
    if (flagToken === '-c' || flagToken === '--command') {
      const arg = readShellArgument(rest);
      return arg?.value ?? null;
    }
    if (/^-(?:u|C|S)$/.test(flagToken) || /^(?:--unset|--chdir|--split-string)$/.test(flagToken)) {
      const arg = readShellArgument(rest);
      if (arg === null) {
        return null;
      }
      rest = arg.rest;
    }
  }
  return null;
}

export interface ShellNestingResult {
  exceeded: boolean;
  payloads: string[];
}

/** S2: walk nested shell -c payloads; deny when depth exceeds MAX_PAYLOAD_DEPTH. */
export function analyzeShellNesting(command: string, depth: number): ShellNestingResult {
  if (depth > MAX_PAYLOAD_DEPTH) {
    return { exceeded: true, payloads: [] };
  }

  const payloads: string[] = [];
  for (const rawSegment of splitCommand(command)) {
    const segment = stripAssignments(rawSegment);
    const payload = extractShellPayload(segment);
    if (payload === null || payload === '') {
      continue;
    }
    payloads.push(payload);
    const inner = analyzeShellNesting(payload, depth + 1);
    if (inner.exceeded) {
      return { exceeded: true, payloads: [...payloads, ...inner.payloads] };
    }
    payloads.push(...inner.payloads);
  }
  return { exceeded: false, payloads };
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

/**
 * Pure scan: the first declared secret whose $VAR/${VAR} form appears in the
 * segment. No command gating — callers decide which commands warrant it.
 */
export function declaredVarReference(segment: string, declared: Set<string>): string | null {
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

export function echoReferencesSecret(segment: string, declared: Set<string>): string | null {
  if (!/\b(?:echo|printf)\b/.test(segment)) {
    return null;
  }
  return declaredVarReference(segment, declared);
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
  if (FILE_TOOLS.has(call.tool)) {
    const path = call.path;
    if (path !== undefined && isDeniedSecretPath(path)) {
      const verb = call.tool === 'Read' ? 'reading' : call.tool === 'Write' ? 'writing' : 'editing';
      return {
        allow: false,
        reason:
          `Blocked: ${verb} \`${path}\` would put its contents in the transcript. ` +
          'Use `env_describe` for status or `env_verify` to test the key.',
      };
    }
    if (path !== undefined && isEnvSchemaJsoncPath(path)) {
      const cwd = context?.cwd ?? process.cwd();
      const resolved = resolveFilePath(path, cwd);
      if (envSchemaJsoncHasHighConfidenceSecret(resolved)) {
        return { allow: false, reason: ENV_SCHEMA_SECRET_DENY_REASON };
      }
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
  const nesting = analyzeShellNesting(command, 0);
  if (nesting.exceeded) {
    return {
      allow: false,
      reason: 'envseal hook: command nesting too deep',
    };
  }

  for (const payload of nesting.payloads) {
    const inner = decideBashSegments(payload, declared);
    if (!inner.allow) {
      return inner;
    }
  }

  return decideBashSegments(command, declared);
}

function decideBashSegments(command: string, declared: Set<string>): Decision {
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

    // W3-07 + audit follow-up: bash's `$(<file)` shorthand AND any mid-command
    // input redirection (`base64 -w0 < .env`, `wc -c < .env`) read a file into
    // the transcript with no recognized reader command. Scan every whitespace
    // token for a single-arrow redirect; `<<<` is a here-string (literal body,
    // not a file read) and is handled by the declared-variable scan below.
    const words = segment.split(/\s+/);
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      let candidate: string | undefined;
      if (word === '<' && i + 1 < words.length) {
        candidate = words[i + 1];
      } else if (/^<[^<]/.test(word)) {
        candidate = word.slice(1); // glued form: `$(<.env)`, `<.env`
      }
      if (candidate === undefined || candidate === '') {
        continue;
      }
      const token = candidate.replace(/^['"]+|['"]+$/g, '').replace(/^~/, '');
      if (isDeniedSecretPath(token)) {
        return {
          allow: false,
          reason:
            `Blocked: \`< ${token}\` would put the contents of \`${token}\` in the transcript. ` +
            'Use `env_describe` for status or `env_verify` to test the key.',
        };
      }
    }

    if (head === 'declare' || head === 'typeset' || head === 'local') {
      // `-p` prints definitions WITH values of every matching variable.
      if (/(^|\s)-\w*p/.test(segment)) {
        return {
          allow: false,
          reason:
            `Blocked: \`${head} -p\` would print variable definitions, including secret values. ` +
            'Use `env_describe` to list declared keys instead.',
        };
      }
    }

    // Audit follow-up: a here-string pipes whatever it expands to straight
    // into a command's stdin — `cat <<< $OPENAI_API_KEY` prints the value
    // without any reader-on-path shape. Any segment carrying `<<<` gets the
    // declared-variable scan regardless of its command.
    if (segment.includes('<<<')) {
      const exposed = declaredVarReference(segment, declared);
      if (exposed !== null) {
        return {
          allow: false,
          reason:
            `Blocked: this command would expand $${exposed} into output. ` +
            `Store it with \`/env:set ${exposed}\` and inject it via \`env_use\` if a command needs it.`,
        };
      }
    }

    if (head === 'echo' || head === 'printf') {
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

/**
 * Claude Code's PreToolUse contract. The decision is read from
 * `hookSpecificOutput.permissionDecision`, and `hookEventName` must be present
 * and match the fired event; anything else is ignored and the tool call
 * proceeds. A previous version emitted `permissionDecision` at the TOP level,
 * which Claude Code does not read — every `.env` read this hook was installed
 * to deny was silently allowed, while the bundle exited 0 and looked healthy.
 *
 * See https://code.claude.com/docs/en/hooks (PreToolUse output).
 */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
  };
}

/** S1: fail-open by default; ENVSEAL_HOOK_FAIL_CLOSED=1 inverts on internal error. */
export function internalErrorDecision(error: unknown): Decision {
  const message = error instanceof Error ? error.message : String(error);
  const failClosed = process.env.ENVSEAL_HOOK_FAIL_CLOSED === '1';
  return {
    allow: !failClosed,
    reason: `envseal hook error: ${message}`,
  };
}

export function toHookOutput(decision: Decision): PreToolUseHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allow ? 'allow' : 'deny',
      permissionDecisionReason:
        decision.reason ?? (decision.allow ? 'No envseal rule matched.' : 'Blocked by envseal.'),
    },
  };
}

export function run(): Promise<void> {
  return readPayload<Payload>()
    .then((payload) => {
      const call = normalizePayload(payload);
      const root = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
      const declaredSecrets = loadDeclaredSecrets(findProjectRoot(root));
      const decision = decide(call, { declaredSecrets, cwd: root });
      return toHookOutput(decision);
    })
    .then((result) => {
      writeResult(result);
    });
}

if (process.argv[1] !== undefined) {
  const isMain = /pre-tool-use(?:\.cjs|\.js|\.ts)?$/.test(process.argv[1]);
  if (isMain) {
    run().catch((error: unknown) => {
      // Fail open by default: an internal error must not block tool use.
      writeResult(toHookOutput(internalErrorDecision(error)));
    });
  }
}
