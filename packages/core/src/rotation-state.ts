import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir } from './paths.js';
import type { ProjectPaths } from './paths.js';

/**
 * Age tracking for stored secret bytes.
 *
 * The manifest's `rotation.maxAgeDays` policy is only actionable if we know
 * when the stored value last changed. Nothing else records that: provisioning
 * via `env_use` happens once, hand-written .env values never cross any envseal
 * write path at all, and the audit log answers "who did what", not "how old
 * are the bytes". So `Broker.describe()` lazily stamps a record the first time
 * it sees a key, and re-stamps when the value's fingerprint changes.
 *
 * This is observational state, deliberately outside the audit chain: the
 * caller of describe() is often the model itself, and a read that grows the
 * audit log with model-attributed "rotation" events would manufacture
 * evidence. The timestamp says the BYTES changed, never who changed them.
 */

export interface RotationRecord {
  /** Fingerprint of the value this age stamp was computed for. */
  fingerprint: string;
  /** ISO timestamp of the first observation of this fingerprint. */
  at: string;
}

type RotationFile = Record<string, RotationRecord>;

function statePath(paths: ProjectPaths): string {
  return join(paths.stateDir, 'rotation.json');
}

function load(paths: ProjectPaths): RotationFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(paths), 'utf8'));
    if (parsed !== null && typeof parsed === 'object') return parsed as RotationFile;
  } catch {
    // Missing or unreadable: no age known yet, reported as "due now is
    // unknowable" rather than invented.
  }
  return {};
}

export function loadRotationState(paths: ProjectPaths): Record<string, RotationRecord> {
  return load(paths);
}

/** Stamp (or re-stamp) a key's age marker. Returns the record written. */
export function recordRotation(
  paths: ProjectPaths,
  key: string,
  fingerprint: string,
  now: Date = new Date(),
): RotationRecord {
  ensureStateDir(paths);
  const all = load(paths);
  const record: RotationRecord = { fingerprint, at: now.toISOString() };
  all[key] = record;
  const file = statePath(paths);
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best effort
    }
  }
  return record;
}
