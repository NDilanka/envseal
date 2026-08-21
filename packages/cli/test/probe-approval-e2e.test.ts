/**
 * The probe-approval consent flow (PLAN.md §6.4, spec/sep-1/SPEC.md:507-511),
 * asserted against the shipped `dist/bin.js`.
 *
 * Core has implemented the consent record all along; the CLI supplied no
 * `onApprovalNeeded`, so the flow was unreachable and every off-allowlist probe
 * returned `probe_not_approved` with no way for a user to say yes. These tests
 * exist to keep the wiring present, so the display is exercised on every run
 * rather than only under a mocked callback in a core unit test.
 *
 * The probe host is `.invalid` (RFC 6761 — guaranteed never to resolve), so an
 * approved probe still fails at the network. What is under test is who gets
 * asked and what is recorded, not whether an unknown host answers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'dist', 'bin.js');

const SENTINEL = 'sk-SENTINEL-APPROVAL-DO-NOT-LEAK-9f8e7d6c5b4a';
const PROBE_HOST = 'probe-approval-fixture.invalid';
const PROBE_URL = `https://${PROBE_HOST}/v1/whoami`;
const WATCHDOG_MS = 20_000;

const ASKED = 'needs your approval before verifying';

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): CliRun {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CI' || v === undefined) continue;
    base[k] = v;
  }
  Object.assign(base, env);

  const result = spawnSync('node', [binPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: base,
    timeout: WATCHDOG_MS,
    input: '',
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    signal: result.signal ?? null,
  };
}

function writeProbeManifest(root: string, headerTemplate: Record<string, string>): void {
  writeFileSync(
    join(root, 'env.schema.jsonc'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            key: 'APPROVAL_KEY',
            description: 'Key whose probe targets a host outside the registry allowlist',
            required: true,
            secret: true,
            sink: 'dotenv',
            verify: {
              method: 'GET',
              url: PROBE_URL,
              headerTemplate,
              expectStatus: [200],
            },
          },
        ],
      },
      null,
      2,
    ),
  );
}

function readApprovals(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.envseal', 'approvals.json'), 'utf8'));
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'envseal-approval-'));
  writeFileSync(join(root, '.gitignore'), '.env\n');
  writeProbeManifest(root, { Authorization: 'Bearer {{value}}' });
  writeFileSync(join(root, '.env'), `APPROVAL_KEY=${SENTINEL}\n`);
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function verify(env: Record<string, string> = {}): CliRun {
  return runCli(root, ['verify', 'APPROVAL_KEY', '--project', root, '--json'], env);
}

describe('probe approval: the consent prompt is reachable', () => {
  it('asks, shows method + URL + header template, and never shows the value', () => {
    const r = verify({ ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_APPROVAL: 'yes' });

    expect(r.stderr).toContain(ASKED);
    expect(r.stderr).toContain(PROBE_HOST);
    expect(r.stderr).toContain('method:  GET');
    expect(r.stderr).toContain(PROBE_URL);
    expect(r.stderr).toContain('Authorization: Bearer {{value}}');

    // The placeholder is what is displayed; the credential itself is not.
    expect(r.stderr).not.toContain(SENTINEL);
    expect(r.stdout).not.toContain(SENTINEL);

    // Approved, so the probe was attempted and failed at DNS rather than being
    // refused. Either way verify failed, so the exit code is 6.
    expect(JSON.parse(r.stdout).results[0].result).toBe('network_error');
    expect(r.exitCode).toBe(6);
  });

  it('returns probe_not_approved and exit 6 when the user says no', () => {
    const r = verify({ ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_APPROVAL: 'no' });

    expect(r.stderr).toContain(ASKED);
    expect(JSON.parse(r.stdout).results[0].result).toBe('probe_not_approved');
    expect(r.exitCode).toBe(6);
    expect(existsSync(join(root, '.envseal', 'approvals.json'))).toBe(false);
  });
});

describe('probe approval: the decision is recorded and replayed', () => {
  it('does not re-ask on a second identical verify', () => {
    const first = verify({ ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_APPROVAL: 'yes' });
    expect(first.stderr).toContain(ASKED);

    // Second run carries no approval variables at all: if the record were not
    // replayed this would have to ask, and with no surface it would refuse.
    const second = verify();
    expect(second.stderr).not.toContain(ASKED);
    expect(JSON.parse(second.stdout).results[0].result).toBe('network_error');
    expect(second.exitCode).toBe(6);
  });

  it('re-asks when the header template changes', () => {
    verify({ ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_APPROVAL: 'yes' });

    writeProbeManifest(root, { 'X-Api-Key': '{{value}}' });

    const after = verify();
    expect(after.stderr).toContain(ASKED);
    expect(after.stderr).toContain('X-Api-Key: {{value}}');
    expect(JSON.parse(after.stdout).results[0].result).toBe('probe_not_approved');
    expect(after.exitCode).toBe(6);
  });

  it('re-asks when the URL changes', () => {
    verify({ ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_APPROVAL: 'yes' });

    const manifestPath = join(root, 'env.schema.jsonc');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace('/v1/whoami', '/v2/whoami'),
    );

    const after = verify();
    expect(after.stderr).toContain(ASKED);
    expect(JSON.parse(after.stdout).results[0].result).toBe('probe_not_approved');
  });

  it('records host, method and URL but never the credential', () => {
    verify({ ENVSEAL_TEST_MODE: '1', ENVSEAL_TEST_APPROVAL: 'yes' });

    const raw = readFileSync(join(root, '.envseal', 'approvals.json'), 'utf8');
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain('Bearer sk-');

    const records = Object.values(readApprovals(root)) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toEqual({
      key: 'APPROVAL_KEY',
      method: 'GET',
      url: PROBE_URL,
      headerHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe('probe approval: fails closed with no interactive surface', () => {
  it('CI=1 refuses without hanging and says why', () => {
    const r = verify({ CI: '1' });

    expect(r.signal).toBe(null);
    expect(r.exitCode).toBe(6);
    expect(JSON.parse(r.stdout).results[0].result).toBe('probe_not_approved');

    // A CI log reader must be able to act on this: the real cause, the host,
    // and the one command that fixes it.
    expect(r.stderr).toContain('CI is set in the environment');
    expect(r.stderr).toContain(PROBE_HOST);
    expect(r.stderr).toContain('The probe was NOT sent');
    expect(r.stderr).toContain('envseal verify APPROVAL_KEY');
    expect(r.stderr).not.toContain(SENTINEL);

    // Failing closed means nothing was recorded.
    expect(existsSync(join(root, '.envseal', 'approvals.json'))).toBe(false);
  });

  it('a non-TTY stdin without CI also refuses rather than blocking on a read', () => {
    const r = verify();

    expect(r.signal).toBe(null);
    expect(r.exitCode).toBe(6);
    expect(r.stderr).toContain('stdin is not a terminal');
    expect(JSON.parse(r.stdout).results[0].result).toBe('probe_not_approved');
  });
});

describe('probe approval: allowlisted hosts are not gated', () => {
  it('never asks for a host on the bundled registry allowlist', { timeout: 60_000 }, () => {
    const allowlisted = mkdtempSync(join(tmpdir(), 'envseal-approval-allow-'));
    try {
      writeFileSync(
        join(allowlisted, 'env.schema.jsonc'),
        JSON.stringify({
          version: 1,
          entries: [
            {
              key: 'OPENAI_API_KEY',
              description: 'Allowlisted probe',
              required: true,
              secret: true,
              sink: 'dotenv',
              verify: {
                method: 'GET',
                url: 'https://api.openai.com/v1/models',
                headerTemplate: { Authorization: 'Bearer {{value}}' },
                expectStatus: [401],
              },
            },
          ],
        }),
      );
      writeFileSync(join(allowlisted, '.env'), 'OPENAI_API_KEY=sk-not-real\n');

      const r = runCli(allowlisted, ['verify', '--project', allowlisted, '--json']);
      expect(r.stderr).not.toContain(ASKED);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(existsSync(join(allowlisted, '.envseal', 'approvals.json'))).toBe(false);
    } finally {
      rmSync(allowlisted, { recursive: true, force: true });
    }
  });
});
