import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  chmodSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, basename, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { asSecret, SepError } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import { ensureStateDir } from '../paths.js';
import type { ProjectPaths } from '../paths.js';
import type { Sink } from './types.js';

export type DotenvLine =
  | { kind: 'comment'; text: string }
  | { kind: 'blank'; text: string }
  | { kind: 'raw'; text: string }
  | {
      kind: 'assignment';
      text: string;
      key: string;
      value: string;
      quote: '"' | "'" | null;
      exported: boolean;
      lead: string;
      prefix: string;
      trailing: string;
    };

export interface ParsedDotenv {
  lines: DotenvLine[];
  eol: '\r\n' | '\n';
  bom: boolean;
  trailingNewline: boolean;
}

const isPosix = process.platform !== 'win32';

/**
 * The single permitted SecretValue -> string conversion in the whole broker.
 * It exists so a value can be handed to the dotenv sink for writing (and, in
 * turn, fed to the redactor). It MUST NOT be re-exported from the package
 * index and MUST NOT be used for logging, printing, or error messages.
 */
export function unsafeSecretToUtf8(value: SecretValue): string {
  return value.toString('utf8');
}

const ASSIGNMENT_RE = /^(\s*)(?:export\s+)?([A-Za-z0-9_.]+)\s*=\s*(.*)$/;

export function parseDotenv(text: string): ParsedDotenv {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const eol: '\r\n' | '\n' = body.includes('\r\n') ? '\r\n' : '\n';
  const rawLines = body.split(/\r\n|\n/);
  let trailingNewline = false;
  if (body.endsWith('\n')) {
    rawLines.pop();
    trailingNewline = true;
  }
  const lines = rawLines.map(parseLine);
  return { lines, eol, bom, trailingNewline };
}

function parseLine(raw: string): DotenvLine {
  if (/^\s*$/.test(raw)) return { kind: 'blank', text: raw };
  if (/^\s*#/.test(raw)) return { kind: 'comment', text: raw };
  const match = ASSIGNMENT_RE.exec(raw);
  if (!match) return { kind: 'raw', text: raw };
  const lead = match[1] ?? '';
  const key = match[2] ?? '';
  const exported = /^export\s/.test(raw.slice(lead.length));
  let rest = match[3] ?? '';
  let quote: '"' | "'" | null = null;
  let value = '';
  let trailing = '';
  const first = rest[0];
  if (first === '"' || first === "'") {
    quote = first;
    rest = rest.slice(1);
    let str = '';
    let i = 0;
    let closed = false;
    for (; i < rest.length; i++) {
      const ch = rest[i]!;
      if (ch === '\\' && quote === '"') {
        const next = rest[i + 1];
        i++;
        if (next === 'n') str += '\n';
        else if (next === 'r') str += '\r';
        else if (next === 't') str += '\t';
        else if (next === '"') str += '"';
        else if (next === '\\') str += '\\';
        else str += next ?? '';
      } else if (ch === quote) {
        closed = true;
        i++;
        break;
      } else {
        str += ch;
      }
    }
    if (!closed) return { kind: 'raw', text: raw };
    value = str;
    trailing = rest.slice(i);
  } else {
    const commentMatch = /(\s+)#/.exec(rest);
    if (commentMatch && commentMatch[1]) {
      value = rest.slice(0, commentMatch.index).replace(/\s+$/, '');
      trailing = rest.slice(commentMatch.index);
    } else {
      value = rest.replace(/\s+$/, '');
      trailing = '';
    }
  }
  return {
    kind: 'assignment',
    text: raw,
    key,
    value,
    quote,
    exported,
    lead,
    prefix: exported ? 'export ' : '',
    trailing,
  };
}

export function serializeDotenv(parsed: ParsedDotenv): string {
  const body = parsed.lines.map((line) => line.text).join(parsed.eol);
  let out = parsed.bom ? '\uFEFF' : '';
  out += body;
  if (parsed.trailingNewline) out += parsed.eol;
  return out;
}

function escapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function renderValue(value: string, prefer: '"' | "'" | null = null): string {
  const needsQuote =
    value.length === 0 ||
    /[\s#\\]/.test(value) ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes('"') ||
    value.includes("'");
  if (!needsQuote) {
    if (prefer === '"') return `"${value}"`;
    if (prefer === "'") return `'${value}'`;
    return value;
  }
  if (prefer === "'" && !/[\r\n'"\\]/.test(value)) {
    return `'${value}'`;
  }
  return `"${escapeDoubleQuoted(value)}"`;
}

function rebuildAssignment(line: DotenvLine, value: string): DotenvLine {
  if (line.kind !== 'assignment') return line;
  const text = `${line.lead}${line.prefix}${line.key}=${renderValue(value, line.quote)}${line.trailing}`;
  return { ...line, value, text };
}

// On Windows, touching a file another process has a handle on intermittently
// fails with EPERM / EACCES / EBUSY: antivirus scanners, the search indexer and
// editors all take brief handles on a file they just saw written. The operation
// succeeds once the handle is released, so the fix is a bounded retry rather
// than a fallback to something non-atomic. Found by the dotenv property test,
// which only reproduced it after ~250 writes in quick succession.
//
// F-W7-4: this used to guard the rename only. The same transient handle fails
// the *read* just as readily — and a read failure happens before the rename
// loop is ever reached, so the retry budget never ran.
const RETRY_DELAYS_MS = [1, 2, 5, 10, 25, 50, 100];
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function withTransientRetry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_CODES.has(code)) throw error;
      lastError = error;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      // Synchronous sleep: this path must stay sync because the whole sink API
      // is sync, and the waits are sub-100ms.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  throw lastError;
}

function readFileIfPresent(path: string): string | null {
  try {
    return withTransientRetry(() => readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

function writeTempFile(tmp: string, content: string): void {
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (isPosix) chmodSync(tmp, 0o600);
}

/**
 * Write `content` to `target` so that a reader never observes a partial file.
 *
 * The temp file holds the complete plaintext, so where it lives matters
 * (F-W7-3): `.<basename>.<hex>.tmp` next to the target is `..env.<hex>.tmp`,
 * which a `.gitignore` entry of `.env` does NOT match — a leftover would be a
 * stageable plaintext secret. It goes in `.envseal/` instead, which is mode
 * 0700 and carries its own `.gitignore` of `*` (see ensureStateDir).
 *
 * `.envseal/` is `<root>/.envseal`, so it is on the same volume as `.env` by
 * construction and the rename stays atomic. If someone has made it a junction
 * onto another volume the rename reports EXDEV, and we fall back to a sibling
 * temp file rather than performing a non-atomic cross-volume copy.
 */
function atomicWrite(paths: ProjectPaths, target: string, content: string): void {
  const suffix = `${basename(target)}.${randomBytes(6).toString('hex')}.tmp`;
  const sibling = join(dirname(target), `.${suffix}`);
  let tmp = join(paths.stateDir, suffix);
  try {
    ensureStateDir(paths);
    writeTempFile(tmp, content);
  } catch {
    tmp = sibling;
    writeTempFile(tmp, content);
  }
  try {
    renameOverwrite(tmp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    writeTempFile(sibling, content);
    renameOverwrite(sibling, target);
  }
}

function renameOverwrite(tmp: string, target: string): void {
  try {
    withTransientRetry(() => renameSync(tmp, target));
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort: leaving a stray tmp file is preferable to masking the error
    }
    throw error;
  }
}

/**
 * F-W7-4: every filesystem failure used to escape as a bare Node error, so the
 * CLI never mapped it to exit code 5 and the message carried the target's
 * absolute path. Callers see SEP_SINK_WRITE_FAILED with the errno only.
 */
function asSinkWriteError(error: unknown, target: string): SepError {
  if (error instanceof SepError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const name = basename(target);
  const detail =
    code === undefined
      ? ''
      : ` (${code}) — it may be open in another program, read-only, or on a full disk`;
  return new SepError({
    code: 'SEP_SINK_WRITE_FAILED',
    userMessage: `Could not update ${name} in the project directory${detail}.`,
    details: { file: name, errno: code ?? null },
  });
}

function runGit(cwd: string, args: string[]): number {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === 'number' ? status : 1;
  }
}

function assertGitSafe(paths: ProjectPaths, allowUnsafe: boolean | undefined): void {
  if (allowUnsafe) return;
  if (runGit(paths.root, ['rev-parse', '--is-inside-work-tree']) !== 0) return;
  const relPath = relative(paths.root, paths.dotenv);
  const tracked = runGit(paths.root, ['ls-files', '--error-unmatch', '--', relPath]) === 0;
  if (tracked) {
    throw new SepError({ code: 'SEP_GITIGNORE_UNSAFE' });
  }
  const ignored = runGit(paths.root, ['check-ignore', '-q', relPath]) === 0;
  if (!ignored) {
    throw new SepError({ code: 'SEP_GITIGNORE_UNSAFE' });
  }
}

export interface WriteDotenvOptions {
  allowUnsafe?: boolean;
  description?: string;
}

export function readDotenv(paths: ProjectPaths): Record<string, string> {
  const text = readFileIfPresent(paths.dotenv);
  if (text === null) return {};
  const parsed = parseDotenv(text);
  const out: Record<string, string> = {};
  for (const line of parsed.lines) {
    if (line.kind === 'assignment' && line.key.length > 0) {
      out[line.key] = line.value;
    }
  }
  return out;
}

function sanitizeComment(description: string): string {
  return description.replace(/[\r\n]+/g, ' ').trim();
}

function buildNewFile(key: string, value: string, description?: string): string {
  const lines: string[] = [
    '# This file is managed by envseal. It contains real secrets.',
    '# Do NOT commit it to version control.',
  ];
  if (description !== undefined && description.length > 0) {
    lines.push(`# ${sanitizeComment(description)}`);
  }
  lines.push(`${key}=${renderValue(value)}`);
  return `${lines.join('\n')}\n`;
}

function buildAppendLines(key: string, value: string, description: string | undefined): DotenvLine[] {
  const lines: DotenvLine[] = [];
  if (description !== undefined && description.length > 0) {
    lines.push({ kind: 'comment', text: `# ${sanitizeComment(description)}` });
  }
  lines.push({
    kind: 'assignment',
    text: `${key}=${renderValue(value)}`,
    key,
    value,
    quote: null,
    exported: false,
    lead: '',
    prefix: '',
    trailing: '',
  });
  return lines;
}

export function setDotenvValue(
  paths: ProjectPaths,
  key: string,
  value: string,
  options?: WriteDotenvOptions,
): void {
  // Outside the try: SEP_GITIGNORE_UNSAFE is a refusal, not a write failure.
  assertGitSafe(paths, options?.allowUnsafe);
  try {
    const text = readFileIfPresent(paths.dotenv);
    if (text === null) {
      atomicWrite(paths, paths.dotenv, buildNewFile(key, value, options?.description));
      return;
    }
    const parsed = parseDotenv(text);
    let lastIndex = -1;
    parsed.lines.forEach((line, index) => {
      if (line.kind === 'assignment' && line.key === key) lastIndex = index;
    });
    if (lastIndex >= 0) {
      const existing = parsed.lines[lastIndex];
      if (existing && existing.kind === 'assignment') {
        parsed.lines[lastIndex] = rebuildAssignment(existing, value);
      }
    } else {
      parsed.lines.push(...buildAppendLines(key, value, options?.description));
    }
    atomicWrite(paths, paths.dotenv, serializeDotenv(parsed));
  } catch (error) {
    throw asSinkWriteError(error, paths.dotenv);
  }
}

export function removeDotenvKey(paths: ProjectPaths, key: string, options?: { allowUnsafe?: boolean }): boolean {
  assertGitSafe(paths, options?.allowUnsafe);
  try {
    const parsed = parseDotenv(readFileIfPresent(paths.dotenv) ?? '');
    const before = parsed.lines.length;
    parsed.lines = parsed.lines.filter((line) => !(line.kind === 'assignment' && line.key === key));
    const removed = parsed.lines.length !== before;
    if (removed) {
      atomicWrite(paths, paths.dotenv, serializeDotenv(parsed));
    }
    return removed;
  } catch (error) {
    throw asSinkWriteError(error, paths.dotenv);
  }
}

export class DotenvSink implements Sink {
  readonly id = 'dotenv';

  async available(_paths: ProjectPaths): Promise<boolean> {
    return true;
  }

  async read(paths: ProjectPaths, key: string): Promise<SecretValue | null> {
    const values = readDotenv(paths);
    const value = values[key];
    if (value === undefined) return null;
    return asSecret(Buffer.from(value, 'utf8'));
  }

  async write(paths: ProjectPaths, key: string, value: SecretValue, options?: WriteDotenvOptions): Promise<void> {
    setDotenvValue(paths, key, unsafeSecretToUtf8(value), options);
  }

  async remove(paths: ProjectPaths, key: string, options?: { allowUnsafe?: boolean }): Promise<boolean> {
    return removeDotenvKey(paths, key, options);
  }
}
