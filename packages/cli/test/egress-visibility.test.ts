import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { useConfirmationBody } from '@envseal/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', '..', 'cli', 'dist', 'bin.js');

/**
 * T17 visibility: consent dialogs name the destinations when a command can
 * reach the network (or say plainly when the destination could not be
 * determined), and doctor reports the effective egress policy.
 *
 * The dialog body is rendered by useConfirmationBody in @envseal/core; doctor
 * is driven through its built binary exactly like audit-command does.
 */
describe('egress visibility', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'envseal-egress-vis-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('consent dialog names network targets', () => {
    it('lists extracted hosts alongside the warning', () => {
      const body = useConfirmationBody(
        {
          command: ['curl', '-H', 'Authorization: Bearer x', 'https://api.openai.com/v1'],
          keys: ['OPENAI_API_KEY'],
          networkEgress: true,
          egressHosts: ['api.openai.com'],
        },
        tempDir,
      );
      expect(body).toContain('WARNING');
      expect(body).toContain('Network targets: api.openai.com');
    });

    it('says plainly when a destination could not be determined', () => {
      const body = useConfirmationBody(
        {
          command: ['curl', '93.184.216.34'],
          keys: ['K'],
          networkEgress: true,
          egressHosts: ['(unknown)'],
        },
        tempDir,
      );
      expect(body).toContain('Network targets: undetermined (bare IP or encoded)');
    });

    it('omits the target line when hosts were not provided (legacy callers)', () => {
      const body = useConfirmationBody(
        {
          command: ['curl', 'https://example.test'],
          keys: ['K'],
          networkEgress: true,
        },
        tempDir,
      );
      expect(body).toContain('WARNING');
      expect(body).not.toContain('Network targets:');
    });

    it('shows no target line for non-network commands', () => {
      const body = useConfirmationBody(
        {
          command: ['node', 'build.js'],
          keys: ['K'],
          networkEgress: false,
          egressHosts: [],
        },
        tempDir,
      );
      expect(body).not.toContain('WARNING');
      expect(body).not.toContain('Network targets:');
    });

    it('escapes hostile text inside hostnames like every other dialog field', () => {
      const body = useConfirmationBody(
        {
          command: ['curl', 'https://evil.test'],
          keys: ['K'],
          networkEgress: true,
          egressHosts: ['evil.test\nkeys: none'],
        },
        tempDir,
      );
      // The injected newline must be rendered visibly, not obeyed: no dialog
      // line may begin with the forged content.
      expect(body).not.toContain('\nkeys: none');
      expect(body).toContain('evil.test<U+000A>keys: none');
    });
  });

  describe('doctor reports the egress policy', () => {
    function runDoctor(project: string): { stdout: string } {
      const r = spawnSync('node', [binPath, 'doctor', '--json', '--project', project], {
        cwd: project,
        encoding: 'utf-8',
      });
      return { stdout: r.stdout ?? '' };
    }

    function writeManifest(policy: unknown): void {
      const policyBlock =
        policy === undefined ? '' : `,\n  "policy": ${JSON.stringify(policy, null, 2)}`;
      // Minimal manifest with one declared-but-missing key so doctor exits 1
      // (missing required) — assertions target the JSON body, not the code.
      writeFileSync(
        join(tempDir, 'env.schema.jsonc'),
        `{\n  "version": 1,\n  "entries": [\n    {\n      "key": "DOCTOR_EGRESS_KEY",\n      "description": "probe",\n      "required": true\n    }\n  ]${policyBlock}\n}\n`,
      );
    }

    it('reports allowlist mode with its hosts', () => {
      expect(existsSync(binPath), `binary missing at ${binPath}`).toBe(true);
      writeManifest({ egress: { mode: 'allowlist', allow: ['api.openai.com', '*.openai.com'] } });
      const { stdout } = runDoctor(tempDir);
      const parsed = JSON.parse(stdout) as { egressPolicy?: { mode?: string; allow?: string[] } };
      expect(parsed.egressPolicy?.mode).toBe('allowlist');
      expect(parsed.egressPolicy?.allow).toEqual(['api.openai.com', '*.openai.com']);
    });

    it('maps an absent policy section to warn', () => {
      expect(existsSync(binPath), `binary missing at ${binPath}`).toBe(true);
      writeManifest(undefined);
      const { stdout } = runDoctor(tempDir);
      const parsed = JSON.parse(stdout) as { egressPolicy?: { mode?: string } };
      expect(parsed.egressPolicy?.mode).toBe('warn');
    });
  });
});
