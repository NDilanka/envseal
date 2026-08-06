import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectPaths } from '../src/paths.js';
import { appendAudit, readAudit, type AuditEvent } from '../src/audit.js';

describe('audit', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('appendAudit', () => {
    it('creates audit file', () => {
      const paths = projectPaths(tmpDir);
      const event: AuditEvent = { type: 'declare', keys: ['TEST_KEY'] };

      appendAudit(paths, event);

      const stat = statSync(paths.audit);
      expect(stat.isFile()).toBe(true);
    });

    it('appends events as JSONL', () => {
      const paths = projectPaths(tmpDir);
      const event1: AuditEvent = { type: 'declare', keys: ['KEY1'] };
      const event2: AuditEvent = { type: 'declare', keys: ['KEY2'] };

      appendAudit(paths, event1);
      appendAudit(paths, event2);

      const records = readAudit(paths);
      expect(records).toHaveLength(2);
      expect(records[0]?.type).toBe('declare');
      expect(records[1]?.type).toBe('declare');
    });

    it('includes timestamp and version', () => {
      const paths = projectPaths(tmpDir);
      const event: AuditEvent = { type: 'declare', keys: ['TEST_KEY'] };

      appendAudit(paths, event);

      const records = readAudit(paths);
      expect(records[0]?.at).toBeDefined();
      expect(records[0]?.at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('sets file mode to 0o600 on POSIX', () => {
      const paths = projectPaths(tmpDir);
      const event: AuditEvent = { type: 'declare', keys: ['TEST_KEY'] };

      appendAudit(paths, event);

      const stat = statSync(paths.audit);
      if (process.platform !== 'win32') {
        // POSIX: check file mode (mode & 0o777)
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });

  describe('readAudit', () => {
    it('returns empty array if file does not exist', () => {
      const paths = projectPaths(tmpDir);
      const records = readAudit(paths);
      expect(records).toEqual([]);
    });

    it('reads declare events', () => {
      const paths = projectPaths(tmpDir);
      const event: AuditEvent = { type: 'declare', keys: ['KEY1', 'KEY2'] };

      appendAudit(paths, event);
      const records = readAudit(paths);

      expect(records[0]?.type).toBe('declare');
      if (records[0]?.type === 'declare') {
        expect(records[0]?.keys).toEqual(['KEY1', 'KEY2']);
      }
    });

    it('reads request events', () => {
      const paths = projectPaths(tmpDir);
      const event: AuditEvent = {
        type: 'request',
        ticket: 'tkt_123',
        keys: ['KEY1'],
        reason: 'Testing',
        surface: 'test',
      };

      appendAudit(paths, event);
      const records = readAudit(paths);

      expect(records[0]?.type).toBe('request');
      if (records[0]?.type === 'request') {
        expect(records[0]?.ticket).toBe('tkt_123');
        expect(records[0]?.reason).toBe('Testing');
      }
    });

    it('reads stored events', () => {
      const paths = projectPaths(tmpDir);
      const event: AuditEvent = {
        type: 'stored',
        ticket: 'tkt_123',
        key: 'KEY1',
        sink: 'dotenv',
        fingerprint: 'fp_abc123',
      };

      appendAudit(paths, event);
      const records = readAudit(paths);

      expect(records[0]?.type).toBe('stored');
      if (records[0]?.type === 'stored') {
        expect(records[0]?.fingerprint).toBe('fp_abc123');
      }
    });

    it('reads outcome events', () => {
      const paths = projectPaths(tmpDir);
      const event: AuditEvent = {
        type: 'skipped',
        ticket: 'tkt_123',
        key: 'KEY1',
      };

      appendAudit(paths, event);
      const records = readAudit(paths);

      expect(records[0]?.type).toBe('skipped');
    });

    it('reads verify events', () => {
      const paths = projectPaths(tmpDir);
      const event: AuditEvent = {
        type: 'verify',
        key: 'KEY1',
        result: 'ok',
      };

      appendAudit(paths, event);
      const records = readAudit(paths);

      expect(records[0]?.type).toBe('verify');
      if (records[0]?.type === 'verify') {
        expect(records[0]?.result).toBe('ok');
      }
    });

    it('skips corrupt lines', () => {
      const paths = projectPaths(tmpDir);
      const fs = require('node:fs');

      // Manually write a corrupt line alongside a valid event
      appendAudit(paths, { type: 'declare', keys: ['KEY1'] });
      fs.appendFileSync(paths.audit, 'invalid json\n');
      appendAudit(paths, { type: 'declare', keys: ['KEY2'] });

      const records = readAudit(paths);
      expect(records).toHaveLength(2);
      expect(records[0]?.type).toBe('declare');
      expect(records[1]?.type).toBe('declare');
    });
  });

  describe('round-trip', () => {
    it('preserves all event types', () => {
      const paths = projectPaths(tmpDir);
      const events: AuditEvent[] = [
        { type: 'declare', keys: ['KEY1'] },
        {
          type: 'request',
          ticket: 'tkt_1',
          keys: ['KEY1'],
          reason: 'Test',
          surface: 'test',
        },
        {
          type: 'stored',
          ticket: 'tkt_1',
          key: 'KEY1',
          sink: 'dotenv',
          fingerprint: 'fp_123',
        },
        { type: 'skipped', ticket: 'tkt_1', key: 'KEY1' },
        { type: 'cancelled', ticket: 'tkt_1', key: 'KEY1' },
        { type: 'timeout', ticket: 'tkt_1', key: 'KEY1' },
        { type: 'verify', key: 'KEY1', result: 'ok' },
        { type: 'revoke', key: 'KEY1', sink: 'dotenv' },
        { type: 'blocked', reason: 'test', detail: 'blocked' },
      ];

      for (const event of events) {
        appendAudit(paths, event);
      }

      const records = readAudit(paths);
      expect(records).toHaveLength(events.length);

      for (let i = 0; i < events.length; i++) {
        expect(records[i]?.type).toBe(events[i]?.type);
      }
    });
  });
});
