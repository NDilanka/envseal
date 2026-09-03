import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ProjectPaths {
  root: string;
  manifest: string;
  dotenv: string;
  stateDir: string;
  salt: string;
  approvals: string;
  audit: string;
}

export function projectPaths(root: string): ProjectPaths {
  const normalizedRoot = resolve(root);
  return {
    root: normalizedRoot,
    manifest: join(normalizedRoot, 'env.schema.jsonc'),
    dotenv: join(normalizedRoot, '.env'),
    stateDir: join(normalizedRoot, '.envseal'),
    salt: join(normalizedRoot, '.envseal', 'salt'),
    approvals: join(normalizedRoot, '.envseal', 'approvals.json'),
    audit: join(normalizedRoot, '.envseal', 'audit.jsonl'),
  };
}

export function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  const original = dir;
  for (;;) {
    if (existsSync(join(dir, 'env.schema.jsonc'))) return dir;
    if (existsSync(join(dir, '.git'))) return dir;
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return original;
    dir = parent;
  }
}

const isPosix = process.platform !== 'win32';

/**
 * A nested .gitignore of `*` makes everything under `.envseal/` invisible to
 * git regardless of what the project's own .gitignore says. The dotenv sink
 * stages its plaintext temp file here (F-W7-3), and a project .gitignore
 * containing `.env` does not cover `.envseal/` — nor did it cover the old
 * sibling temp name `..env.<hex>.tmp`.
 */
const STATE_GITIGNORE = '# Written by envseal: nothing in here belongs in version control.\n*\n';

export function ensureStateDir(paths: ProjectPaths): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  if (isPosix) chmodSync(paths.stateDir, 0o700);
  const guard = join(paths.stateDir, '.gitignore');
  if (!existsSync(guard)) {
    writeFileSync(guard, STATE_GITIGNORE, { mode: 0o600 });
  }
}

/**
 * F-W7-5: a truncated salt file used to be replaced in complete silence. The
 * salt keys every `fp_*` fingerprint in `describe()` output and in the audit
 * log, so a silent swap makes every previously recorded fingerprint mean
 * something different. Regenerating is still the right default — refusing to
 * start over a file the user can simply delete would be worse — but it must be
 * announced.
 *
 * stderr ONLY: stdout is a machine-readable JSON channel for several bindings
 * and the MCP server speaks JSON-RPC on it.
 */
function warnSaltReplaced(actualLength: number): void {
  process.stderr.write(
    `envseal: .envseal/salt is ${actualLength} bytes, expected 32 — generating a new salt. ` +
      'Every fp_* fingerprint recorded before now was derived from the old salt ' +
      'and will no longer match.\n',
  );
}

export function loadOrCreateSalt(paths: ProjectPaths): Buffer {
  ensureStateDir(paths);
  let truncatedLength: number | null = null;
  try {
    const existing = readFileSync(paths.salt);
    if (existing.length === 32) return existing;
    truncatedLength = existing.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (truncatedLength !== null) warnSaltReplaced(truncatedLength);
  const salt = randomBytes(32);
  writeFileSync(paths.salt, salt, { mode: 0o600 });
  if (isPosix) chmodSync(paths.salt, 0o600);
  return salt;
}

// --- Hook liveness heartbeat ------------------------------------------------
//
// The Claude Code PreToolUse hook refreshes this marker after every decision
// (at most once per minute), purely so `envseal doctor` can report WHEN the
// hook last ran instead of only whether its wiring exists. It is
// observational: never a gate, never an audit record. The marker name lives
// here so the writer (plugin) and the reader (doctor) cannot drift.

export const HOOK_HEARTBEAT_FILE = 'hook-heartbeat';

/** ISO timestamp of the hook's last observed run for a project, or null. */
export function readHookHeartbeat(root: string): string | null {
  try {
    const raw = readFileSync(join(resolve(root), '.envseal', HOOK_HEARTBEAT_FILE), 'utf8').trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

// --- Hook decision counters --------------------------------------------------
//
// The heartbeat proves the hook RAN; it says nothing about whether the matcher
// ever fires. These cumulative allow/deny counters answer that next question:
// a hook that runs but decides wrongly (or is neutered to allow everything)
// shows allow > 0 with deny stuck at 0. They prove the matcher FIRES, not that
// every decision is right — a same-uid agent can rewrite them, so they are
// observational and advisory, exactly like the heartbeat.
//
// Deliberately a SECOND file, not a second line in the heartbeat: older
// readers parse the heartbeat as a bare timestamp, and an unreadable new
// format would regress them to "never ran". An absent counter file reads as
// null ("unknown", pre-counters hook), never as zero.
//
// Counts are approximate under concurrent hook invocations (read-modify-write
// can lose an increment). Direction survives imprecision: deny > 0 still
// proves a deny happened.

export const HOOK_DECISIONS_FILE = 'hook-decisions';

export interface HookDecisions {
  allow: number;
  deny: number;
}

function isHookDecisions(value: unknown): value is HookDecisions {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.allow === 'number' &&
    Number.isInteger(rec.allow) &&
    rec.allow >= 0 &&
    typeof rec.deny === 'number' &&
    Number.isInteger(rec.deny) &&
    rec.deny >= 0
  );
}

/** Cumulative hook decisions for a project, or null when unknown. */
export function readHookDecisions(root: string): HookDecisions | null {
  try {
    const raw = readFileSync(join(resolve(root), '.envseal', HOOK_DECISIONS_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isHookDecisions(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Increment the allow or deny counter. Never throws; never touches decisions. */
export function recordHookDecision(root: string, allow: boolean): void {
  try {
    const stateDir = join(resolve(root), '.envseal');
    const marker = join(stateDir, HOOK_DECISIONS_FILE);
    const current = readHookDecisions(root) ?? { allow: 0, deny: 0 };
    if (allow) {
      current.allow += 1;
    } else {
      current.deny += 1;
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  } catch {
    // Observational only — an unwritable counter changes nothing.
  }
}
