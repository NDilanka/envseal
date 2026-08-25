import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSecret } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import { readAudit } from '../src/audit.js';
import { runWithSecrets } from '../src/exec.js';

// Long enough to clear the redaction engine's minimum-length floor, so the
// sentinel rides the same filtered exit stdout/stderr already go through.
const SENTINEL = 'envseal-audit-sentinel-9c4f2b7e';

describe('env_use execution audit', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-audit-use-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'records exactly one use record followed by one use_result for a successful env_use',
    { timeout: 30_000 },
    async () => {
      const paths = projectPaths(tmpDir);
      const value = asSecret(Buffer.from(SENTINEL, 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);
      const command = ['node', '-e', 'process.exit(0)'];

      const result = await runWithSecrets(command, secrets, {
        cwd: tmpDir,
        auditPaths: paths,
        onConfirm: async () => true,
      });

      expect(result.exitCode).toBe(0);

      const records = readAudit(paths);
      expect(records).toHaveLength(2);

      const attempt = records[0];
      expect(attempt?.type).toBe('use');
      if (attempt?.type === 'use') {
        expect(attempt.keys).toEqual(['TEST_KEY']);
        // Persisted command names the program but carries no secret value:
        expect(attempt.command).toContain('node');
        expect(attempt.command).toContain('-e');
        expect(attempt.command).not.toContain(SENTINEL);
        expect(attempt.networkEgress).toBe(false);
      }

      const outcome = records[1];
      expect(outcome?.type).toBe('use_result');
      if (outcome?.type === 'use_result') {
        expect(outcome.exitCode).toBe(0);
        expect(outcome.signal).toBeNull();
        expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it(
    'never persists the secret value to audit.jsonl, even when argv smuggles it',
    { timeout: 30_000 },
    async () => {
      const paths = projectPaths(tmpDir);
      const value = asSecret(Buffer.from(SENTINEL, 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);
      // The sentinel rides as a bare argument: the pre-redaction command
      // string contains it, so an unfiltered persist would leak it.
      const command = ['node', '-e', 'process.exit(0)', SENTINEL];

      await runWithSecrets(command, secrets, {
        cwd: tmpDir,
        auditPaths: paths,
        approvedCommands: [command.join(' ')],
      });

      const raw = readFileSync(paths.audit, 'utf8');
      expect(raw).toContain('"type":"use"');
      expect(raw).not.toContain(SENTINEL);
      // One filtered exit: the same engine that scrubs stdout labels the
      // smuggled value in the persisted command.
      expect(raw).toContain('«redacted:TEST_KEY»');
    },
  );

  it(
    'records nothing when consent is denied',
    { timeout: 30_000 },
    async () => {
      const paths = projectPaths(tmpDir);
      const value = asSecret(Buffer.from(SENTINEL, 'utf8'));
      const secrets = new Map([['TEST_KEY', value]]);

      await expect(
        runWithSecrets(['node', '-e', 'process.exit(0)'], secrets, {
          cwd: tmpDir,
          auditPaths: paths,
          onConfirm: async () => false,
        }),
      ).rejects.toMatchObject({ code: 'SEP_CONFIRMATION_DENIED' });

      expect(readAudit(paths)).toHaveLength(0);
    },
  );
});
