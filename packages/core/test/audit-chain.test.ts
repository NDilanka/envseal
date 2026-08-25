import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { projectPaths } from '../src/paths.js';
import {
  appendAudit,
  verifyAuditChain,
  GENESIS_PREV,
  type AuditEvent,
} from '../src/audit.js';

function sha256(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

/** The non-empty raw lines of the audit log, in file order. */
function chainLines(auditPath: string): string[] {
  return readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

describe('audit hash chain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-audit-chain-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('record shape', () => {
    it('numbers records with seq starting at 1', () => {
      const paths = projectPaths(tmpDir);
      appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY2'] });

      const lines = chainLines(paths.audit);
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0] ?? 'null') as { seq?: unknown };
      expect(first.seq).toBe(1);
      const second = JSON.parse(lines[1] ?? 'null') as { seq?: unknown };
      expect(second.seq).toBe(2);
    });

    it('sets prev to the sha256 hex of the previous raw line, genesis = 64 zeros', () => {
      const paths = projectPaths(tmpDir);
      appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY2'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY3'] });

      const genesis = '0'.repeat(64);
      expect(GENESIS_PREV).toBe(genesis);

      const lines = chainLines(paths.audit);
      expect(lines).toHaveLength(3);
      const first = JSON.parse(lines[0] ?? 'null') as { prev?: unknown };
      expect(first.prev).toBe(genesis);
      const second = JSON.parse(lines[1] ?? 'null') as { prev?: unknown };
      expect(second.prev).toBe(sha256(lines[0] ?? ''));
      const third = JSON.parse(lines[2] ?? 'null') as { prev?: unknown };
      expect(third.prev).toBe(sha256(lines[1] ?? ''));
    });

    it('continues an existing chain across separate writes', () => {
      const paths = projectPaths(tmpDir);
      appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
      const firstRun = chainLines(paths.audit);
      expect(firstRun).toHaveLength(1);

      appendAudit(paths, { type: 'declare', keys: ['KEY2'] });
      const lines = chainLines(paths.audit);
      expect(lines).toHaveLength(2);
      const second = JSON.parse(lines[1] ?? 'null') as { seq?: unknown; prev?: unknown };
      expect(second.seq).toBe(2);
      expect(second.prev).toBe(sha256(firstRun[0] ?? ''));
    });
  });

  describe('verifyAuditChain', () => {
    it('verifies a freshly written log as ok', () => {
      const paths = projectPaths(tmpDir);
      appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
      appendAudit(paths, {
        type: 'stored',
        ticket: 'tkt_1',
        key: 'KEY1',
        sink: 'dotenv',
        fingerprint: 'fp_1',
      });

      const result = verifyAuditChain(readFileSync(paths.audit, 'utf8'));
      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(result.brokenAt).toBeUndefined();
    });

    it('verifies an empty log as ok with zero records', () => {
      expect(verifyAuditChain('')).toEqual({ ok: true, count: 0 });
    });

    it('fails on a byte flipped mid-file and reports the offending seq', () => {
      const paths = projectPaths(tmpDir);
      appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY2'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY3'] });

      // Flip a byte inside record 2 while keeping the JSON parseable: the
      // record still looks like a record, so the break must surface through
      // record 3's chained hash of record 2's raw bytes.
      const lines = chainLines(paths.audit);
      const second = lines[1];
      if (second === undefined) throw new Error('expected three records on disk');
      if (!second.includes('"KEY2"')) throw new Error('fixture lost its KEY2 marker');
      lines[1] = second.replace('"KEY2"', '"KEY9"');
      const tampered = `${lines.join('\n')}\n`;

      const result = verifyAuditChain(tampered);
      expect(result.ok).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('fails when a middle line is deleted', () => {
      const paths = projectPaths(tmpDir);
      appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY2'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY3'] });

      const lines = chainLines(paths.audit);
      const survivorAfterGap = lines[2];
      if (survivorAfterGap === undefined) throw new Error('expected three records on disk');
      const deleted = [lines[0] ?? '', survivorAfterGap].join('\n');

      const result = verifyAuditChain(deleted);
      expect(result.ok).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('reports the first break, not a later one', () => {
      const paths = projectPaths(tmpDir);
      for (const key of ['K1', 'K2', 'K3', 'K4']) {
        appendAudit(paths, { type: 'declare', keys: [key] });
      }
      const lines = chainLines(paths.audit);
      // Delete records 2 AND 3: the first gap (missing seq 2) is what a caller
      // needs to hear about first.
      const deleted = [lines[0] ?? '', lines[3] ?? ''].join('\n');
      const result = verifyAuditChain(deleted);
      expect(result.ok).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('still verifies ok when the tail is truncated (documented boundary)', () => {
      // Honest boundary: the chain proves the records that survive are intact
      // and in order. Nothing outside the log records how many records should
      // exist, so a deleted TAIL is indistinguishable from history that never
      // happened. verifyAuditChain must say ok here rather than pretend it can
      // detect something no head pointer was ever kept for.
      const paths = projectPaths(tmpDir);
      appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY2'] });
      appendAudit(paths, { type: 'declare', keys: ['KEY3'] });

      const lines = chainLines(paths.audit);
      const truncated = `${lines.slice(0, 2).join('\n')}\n`;
      const result = verifyAuditChain(truncated);
      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
    });
  });
});
