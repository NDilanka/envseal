import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ensureStateDir } from './paths.js';
import type { ProjectPaths } from './paths.js';

export type AuditEvent =
  | { type: 'declare'; keys: string[] }
  | { type: 'request'; ticket: string; keys: string[]; reason: string; surface: string }
  | { type: 'stored'; ticket: string; key: string; sink: string; fingerprint: string }
  | { type: 'skipped' | 'cancelled' | 'timeout'; ticket: string; key: string }
  | { type: 'verify'; key: string; result: string }
  | { type: 'revoke'; key: string; sink: string }
  | { type: 'blocked'; reason: string; detail: string }
  /**
   * One env_use execution attempt. Written after consent succeeds,
   * immediately before spawn — a crash mid-run still leaves the attempt
   * recorded; denied consent records nothing. The command is persisted only
   * after passing through the redaction engine.
   */
  | { type: 'use'; command: string; keys: string[]; networkEgress: boolean; targetHashes?: Record<string, string> }
  /** How the attempt ended; paired with the preceding 'use' record. */
  | { type: 'use_result'; exitCode: number | null; signal: string | null; durationMs: number };

export type AuditRecord = AuditEvent & { at: string; v: number };

/**
 * Chain fields. `seq` starts at 1; `prev` is the sha256 hex of the previous
 * RAW line (genesis = 64 zeros), so any edit to a surviving record — or its
 * deletion, which surfaces as a seq gap — breaks every successor's
 * attestation and is reported by verifyAuditChain(). The chain proves the
 * records that survive are intact and ordered; nothing outside the log
 * records how many records should exist, so tail truncation is NOT
 * detectable and is documented as an honest boundary rather than hidden.
 */
export const GENESIS_PREV = '0'.repeat(64);

const isPosix = process.platform !== 'win32';

/** sha256 hex of one raw log line (no trailing newline). */
function lineHash(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

/** Last non-empty raw line of the audit file, or null when absent/empty. */
function lastRawLine(auditPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(auditPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}

function lastSeqOf(line: string): number {
  try {
    const parsed = JSON.parse(line) as { seq?: unknown };
    return typeof parsed.seq === 'number' && Number.isInteger(parsed.seq) && parsed.seq > 0 ? parsed.seq : 0;
  } catch {
    return 0;
  }
}

export function appendAudit(paths: ProjectPaths, event: AuditEvent): void {
  ensureStateDir(paths);
  const prevLine = lastRawLine(paths.audit);
  // A corrupt trailing line reads as seq 0, so the next record restarts at 1.
  // That is the honest reading of a log whose head of chain is unverifiable.
  const prev = prevLine === null ? GENESIS_PREV : lineHash(prevLine);
  const seq = prevLine === null ? 1 : lastSeqOf(prevLine) + 1;
  const record = { ...event, at: new Date().toISOString(), v: 1, seq, prev } as AuditRecord & {
    seq: number;
    prev: string;
  };
  const line = `${JSON.stringify(record)}\n`;
  appendFileSync(paths.audit, line, { mode: 0o600 });
  if (isPosix) chmodSync(paths.audit, 0o600);
  mirrorAuditLine(paths.root, line);
}

// --- Out-of-band mirror -----------------------------------------------------
//
// Residual risk §10: the project audit log is agent-writable and tail
// truncation is undetectable from the log alone. The mirror streams the same
// records to a second file under the user's own ~/.envseal, outside the
// project the agent operates in, so `envseal audit --verify` can detect
// records the project log lost. It raises the bar; it is not immutability —
// a same-uid attacker can tamper both copies, and the docs say so.

let mirrorWarned = false;

/** Directory holding per-project mirrors. ENVSEAL_AUDIT_MIRROR=0 opts out;
 *  a path value redirects the mirror (e.g. at a synced folder so records also
 *  leave the machine); unset defaults to ~/.envseal/mirrors. */
function mirrorsDir(): string {
  const setting = process.env.ENVSEAL_AUDIT_MIRROR;
  if (setting !== undefined && setting !== '0' && setting.trim() !== '') {
    return setting;
  }
  return join(homedir(), '.envseal', 'mirrors');
}

/** Mirror file for one project root. The key is sha256 of the project's
 *  canonical path, so the same directory hashes to one mirror file no matter
 *  how the root was spelled — Windows 8.3 short names, symlinks, differing
 *  case, or a trailing separator all collapse to the same identity.
 *  realpathSync.native is the only core API that expands 8.3 short names
 *  (plain realpath does not); it falls back to realpath then to the resolved
 *  spelling when the filesystem or a torn-down project refuses it. */
export function auditMirrorPath(root: string): string {
  const resolved = resolve(root);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    try {
      canonical = realpathSync(resolved);
    } catch {
      // Nonexistent root: the resolved spelling is the best identity available.
    }
  }
  const key = createHash('sha256').update(resolvePosix(canonical), 'utf8').digest('hex');
  return join(mirrorsDir(), `${key}.jsonl`);
}

function resolvePosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Best-effort append of one already-serialized audit line to the project's
 * mirror. Default ON; ENVSEAL_AUDIT_MIRROR=0 opts out. A mirror failure never
 * blocks provisioning and never throws: one fixed stderr warning per process,
 * no path and no error detail (a path or error could carry secret-shaped text).
 */
function mirrorAuditLine(root: string, line: string): void {
  if (process.env.ENVSEAL_AUDIT_MIRROR === '0') {
    return;
  }
  try {
    const mirror = auditMirrorPath(root);
    mkdirSync(dirname(mirror), { recursive: true, mode: 0o700 });
    appendFileSync(mirror, line, { mode: 0o600 });
    if (isPosix) chmodSync(mirror, 0o600);
  } catch {
    if (!mirrorWarned) {
      mirrorWarned = true;
      process.stderr.write('envseal: audit mirror unavailable — continuing without it\n');
    }
  }
}

/** Raw non-empty lines of the project's mirror, or null when there is none. */
export function readMirrorLines(root: string): string[] | null {
  try {
    const raw = readFileSync(auditMirrorPath(root), 'utf8');
    return raw.split(/\r?\n/).filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export interface MirrorComparison {
  mirrorPresent: boolean;
  mirrorRecords: number;
  projectRecords: number;
  /** The mirror holds records the project log no longer does. */
  tailTruncated: boolean;
}

interface SeqLine {
  seq: number;
  line: string;
  prev: string;
}

function parseSeqs(lines: string[]): SeqLine[] {
  const out: SeqLine[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { seq?: unknown; prev?: unknown };
      if (
        typeof parsed.seq === 'number' &&
        Number.isInteger(parsed.seq) &&
        parsed.seq > 0 &&
        typeof parsed.prev === 'string'
      ) {
        out.push({ seq: parsed.seq, line, prev: parsed.prev });
      }
    } catch {
      // Foreign/corrupt mirror lines carry no attestation and are skipped.
    }
  }
  return out;
}

/**
 * Compare the project log's raw bytes against its mirror.
 *
 * Truncation is chain-anchored, not count-based: the mirror's record with
 * seq = projectMaxSeq + 1 must attest exactly the project's last surviving
 * line (prev == sha256 of that raw line) for an alarm to fire. That is
 * cryptographic proof those records existed and were deleted after mirroring.
 * A legitimate full reset (project log restarted at seq 1) does not false-positive:
 * its successor in the mirror was written before the reset, so its prev chain
 * cannot match the new log's lines. An empty project log beside a non-empty
 * mirror is always loss — records demonstrably existed for this project.
 */
export function compareWithMirror(projectRaw: string, mirrorLines: string[] | null): MirrorComparison {
  const projectLines = projectRaw
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
  if (mirrorLines === null) {
    return { mirrorPresent: false, mirrorRecords: 0, projectRecords: projectLines.length, tailTruncated: false };
  }

  const project = parseSeqs(projectLines);
  const mirror = parseSeqs(mirrorLines);
  let tailTruncated = false;

  if (project.length === 0) {
    tailTruncated = mirror.length > 0;
  } else {
    const projectMax = project[project.length - 1]!.seq;
    const successor = mirror.find((m) => m.seq === projectMax + 1);
    if (successor !== undefined && successor.prev === lineHash(project[project.length - 1]!.line)) {
      tailTruncated = true;
    }
  }

  return {
    mirrorPresent: true,
    mirrorRecords: mirror.length,
    projectRecords: project.length,
    tailTruncated,
  };
}

/**
 * Verify the hash chain over the raw lines of an audit log.
 *
 * Blame semantics: a deleted or wrongly-numbered record is reported at its own
 * expected position; a record whose CONTENT was edited in place keeps a valid
 * seq, so the break surfaces through its successor's chained hash — it is
 * blamed on the tampered record itself (brokenAt = k, detected at k+1).
 * Tail truncation verifies OK by design — see the chain-field comment above.
 */
export function verifyAuditChain(raw: string): { ok: boolean; brokenAt?: number; count: number } {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);

  let expectedSeq = 1;
  let prevHash = GENESIS_PREV;

  for (const line of lines) {
    let parsed: { seq?: unknown; prev?: unknown };
    try {
      parsed = JSON.parse(line) as { seq?: unknown; prev?: unknown };
    } catch {
      // Unparseable line at this position IS the corruption.
      return { ok: false, brokenAt: expectedSeq, count: expectedSeq - 1 };
    }
    if (parsed.seq !== expectedSeq) {
      // Missing, duplicated, or renumbered record: blame the position itself.
      return { ok: false, brokenAt: expectedSeq, count: expectedSeq - 1 };
    }
    if (parsed.prev !== prevHash) {
      // This record's attestation over its predecessor fails, so the
      // PREDECESSOR's bytes were changed after the fact. First record with a
      // non-genesis prev means the log head itself was tampered with.
      const blamed = Math.max(1, expectedSeq - 1);
      return { ok: false, brokenAt: blamed, count: expectedSeq - 1 };
    }
    prevHash = lineHash(line);
    expectedSeq += 1;
  }
  return { ok: true, count: expectedSeq - 1 };
}

export function readAudit(paths: ProjectPaths): Array<AuditEvent & { at: string }> {
  let raw: string;
  try {
    raw = readFileSync(paths.audit, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: Array<AuditEvent & { at: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as AuditEvent & { at: string };
      if (typeof parsed.type === 'string' && typeof parsed.at === 'string') {
        records.push(parsed);
      }
    } catch {
      // Corrupt or foreign lines are skipped, never fatal.
    }
  }
  return records;
}
