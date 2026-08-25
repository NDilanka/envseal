import { appendFileSync, readFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  appendFileSync(paths.audit, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (isPosix) chmodSync(paths.audit, 0o600);
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
