import { appendFileSync, readFileSync, chmodSync } from 'node:fs';
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

const isPosix = process.platform !== 'win32';

export function appendAudit(paths: ProjectPaths, event: AuditEvent): void {
  ensureStateDir(paths);
  const record = { ...event, at: new Date().toISOString(), v: 1 } as AuditRecord;
  appendFileSync(paths.audit, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (isPosix) chmodSync(paths.audit, 0o600);
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
