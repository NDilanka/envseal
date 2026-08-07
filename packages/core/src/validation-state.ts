import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { ensureStateDir } from './paths.js';
import type { ProjectPaths } from './paths.js';

/**
 * Persisted format-validation outcomes.
 *
 * This exists to close a chosen-predicate oracle. `env_describe` used to compile
 * the manifest's `format.pattern` — a value the MODEL supplies via `env_declare`
 * — and test it against the live stored secret, returning the boolean. A model
 * could therefore declare `^sk-a`, read the answer, declare `^sk-b`, and
 * reconstruct the whole value one predicate at a time: W2's probe recovered a
 * 33-character secret in 424 calls, with no user interaction and nothing
 * secret-derived ever crossing the wire. The redactor is structurally incapable
 * of catching that, because the value is reassembled from booleans inside the
 * model's own context.
 *
 * The fix is to make the answer not depend on a model-chosen question: validate
 * once, when the value is stored, and afterwards report the recorded outcome.
 * Re-declaring a different pattern changes what future entries are checked
 * against; it cannot re-interrogate a value that is already stored.
 */

export interface ValidationRecord {
  /** Fingerprint of the value this outcome was computed for. */
  fingerprint: string;
  formatValid: boolean;
  at: string;
}

type ValidationFile = Record<string, ValidationRecord>;

function statePath(paths: ProjectPaths): string {
  return paths.stateDir.endsWith('.envseal')
    ? `${paths.stateDir}/validation.json`
    : `${paths.stateDir}/validation.json`;
}

function load(paths: ProjectPaths): ValidationFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(paths), 'utf8'));
    if (parsed !== null && typeof parsed === 'object') return parsed as ValidationFile;
  } catch {
    // Missing or unreadable: no recorded outcomes, which is reported as unknown
    // rather than silently re-evaluated.
  }
  return {};
}

export function recordValidation(
  paths: ProjectPaths,
  key: string,
  fingerprint: string,
  formatValid: boolean,
): void {
  ensureStateDir(paths);
  const all = load(paths);
  all[key] = { fingerprint, formatValid, at: new Date().toISOString() };
  const file = statePath(paths);
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best effort
    }
  }
}

/**
 * The recorded outcome for a value, or null when we have not validated THIS
 * value. Null means "unknown" and must be reported as such — guessing here
 * would reopen the oracle.
 */
export function getValidation(
  paths: ProjectPaths,
  key: string,
  fingerprint: string,
): boolean | null {
  const record = load(paths)[key];
  if (record === undefined) return null;
  if (record.fingerprint !== fingerprint) return null;
  return record.formatValid;
}
