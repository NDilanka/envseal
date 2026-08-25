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
]);
// W3-07: backticks are command substitution too. Without splitting on them,
// `echo "`cat <envfile>`"` was one segment whose head is `echo` — the inner
// reader never got a segment of its own to be checked against.
const SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\||\(|\)|\n|`)\s*/;
// Audit follow-up: `sh -c "cat .env"` executes a payload STRING whose real
// head (`cat`) never appears at the surface — head matching sees only `sh`,
// which matches no reader rule. These shell heads (when they carry -c) and
// `eval` execute such a payload, so the payload must be scanned itself
// instead of passing on its wrapper's innocence.
const SHELL_C_HEADS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'busybox']);
/** How deep `sh -c "sh -c …"` nesting is followed. Generous enough for real
 *  commands, small enough that adversarial nesting cannot make the scanner
 *  do unbounded work; beyond the cap we fail open (heuristic layer, not a
 *  sandbox). */
const MAX_PAYLOAD_DEPTH = 3;
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
  let head = first?.[1] ?? '';
  // Wrapper audit: `sudo cat .env`, `command cat .env`, `xargs cat .env`,
  // `env FOO=1 cat .env` all execute the reader through a transparent
  // wrapper. Strip known wrappers — but ONLY when another word follows, so a
  // bare `env` stays `env` and its own dump check (envIsBare) still fires —
  // then resolve any remaining path prefix to its basename so `/bin/cat
  // .env` matches the same way bare `cat .env` does. Wrapper FLAGS (e.g.
  // `sudo -u root`) end the unwrapping; the denylist stays a heuristic layer,
  // not a shell parser.
  const WRAPPERS = new Set(['sudo', 'command', 'exec', 'builtin', 'nice', 'nohup', 'xargs', 'env']);
  for (;;) {
    const bare = head.replace(/^["']|["']$/g, '');
    if (!WRAPPERS.has(bare)) {
      break;
    }
    let rest = stripped.slice(stripped.indexOf(bare) + bare.length).trim();
    rest = stripAssignments(rest);
    const next = /^([^\s]+)/.exec(rest);
    if (next === null) {
      break; // bare wrapper word: leave it for its own checks
    }
    head = next[1]!;
  }
  return head.split('/').pop() ?? head;
}

/**
 * Extract the command string a `shell -c` / `eval` invocation will execute,
 * or null when this segment carries no such payload. Quote-aware on purpose:
 * naive token splitting would shred `'cat .env'` at the space inside the
 * quotes and leave a headless fragment. Gating happens on the wrapper head
 * (wrapper-stripped, so `sudo sh -c …` counts) BEFORE extraction, so flags
 * of unrelated commands (`git -c foo=bar status`) can never match.
 */
export function dashCPayload(segment: string): string | null {
  const stripped = stripAssignments(segment);
  const head = headOf(stripped);
  const carriesDashC = stripped
    .split(/\s+/)
    .some((token) => /^-[A-Za-z]*c$/.test(token));
  if (!((SHELL_C_HEADS.has(head) && carriesDashC) || head === 'eval')) {
    return null;
  }
  // The payload is the first non-flag argument after the -c/eval marker —
  // shell semantics for -c, and eval's interesting argument is quoted too.
  const match = /(?:^|\s)(?:-[A-Za-z]*c|eval)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(stripped);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  if (raw === undefined || raw === '') {
    return null;
  }
  // A bare-word capture may still wear one layer of quotes.
  const unquoted = raw.replace(/^['"]|['"]$/g, '');
  return unquoted === '' ? null : unquoted;
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

export function decideBash(command: string, declared: Set<string>, depth = 0): Decision {
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

    // Audit follow-up: a `-c`/eval payload runs through the SAME scanner so
    // an inner `cat .env` is judged exactly like a top-level one. Depth-capped
    // (see MAX_PAYLOAD_DEPTH): deeper nesting fails open rather than recursing
    // without bound on adversarial input.
    if (depth < MAX_PAYLOAD_DEPTH) {
      const payload = dashCPayload(segment);
      if (payload !== null) {
        const nested = decideBash(payload, declared, depth + 1);
        if (!nested.allow) {
          return { allow: false, reason: nested.reason };
        }
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
      const decision = decide(call, { declaredSecrets });
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
      // Fail open: an internal error must not block tool use.
      writeResult({
        ...toHookOutput({
          allow: true,
          reason: `envseal hook error: ${error instanceof Error ? error.message : String(error)}`,
        }),
      });
    });
  }
}
