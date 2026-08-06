import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, basename, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { asSecret, SepError } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
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

function readFileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

function atomicWrite(target: string, content: string): void {
  const dir = dirname(target);
  const base = basename(target);
  const tmp = join(dir, `.${base}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (isPosix) chmodSync(tmp, 0o600);
  renameSync(tmp, target);
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
  assertGitSafe(paths, options?.allowUnsafe);
  const text = readFileIfPresent(paths.dotenv);
  if (text === null) {
    atomicWrite(paths.dotenv, buildNewFile(key, value, options?.description));
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
  atomicWrite(paths.dotenv, serializeDotenv(parsed));
}

export function removeDotenvKey(paths: ProjectPaths, key: string, options?: { allowUnsafe?: boolean }): boolean {
  assertGitSafe(paths, options?.allowUnsafe);
  const parsed = parseDotenv(readFileIfPresent(paths.dotenv) ?? '');
  const before = parsed.lines.length;
  parsed.lines = parsed.lines.filter((line) => !(line.kind === 'assignment' && line.key === key));
  const removed = parsed.lines.length !== before;
  if (removed) {
    atomicWrite(paths.dotenv, serializeDotenv(parsed));
  }
  return removed;
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
