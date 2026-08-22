/**
 * The exit-code contract in docs/cli-contract.md, asserted against the shipped
 * artifact.
 *
 * Every assertion here spawns `dist/bin.js` as a child process — that binary,
 * not `src/`, is what a Tier-4 agent runs — and compares the numeric exit code
 * with `toBe`. Never `toBeGreaterThanOrEqual`: `>= 0` is true of every possible
 * outcome including the 0xC0000409 crash this file exists to keep fixed.
 *
 * Every fixture root is an mkdtemp under the OS temp dir. A root inside this
 * repository makes `findProjectRoot` walk up to the workspace and every command
 * then operates on the envseal source tree instead of the fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'dist', 'bin.js');
const repoRoot = resolve(__dirname, '..', '..', '..');

/** Windows STATUS_STACK_BUFFER_OVERRUN — what an aborted node process reports. */
const CRASH_EXIT = 3221226505;

const SENTINEL = 'sk-SENTINEL-CONTRACT-DO-NOT-LEAK-1f2e3d4c5b6a';

/** Hard ceiling on any single CLI invocation, so a hang fails instead of stalling. */
const WATCHDOG_MS = 20_000;

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): CliRun {
  // Start from the ambient environment minus CI: whether CI is set is one of
  // the things under test, so it must come from the case, not the machine.
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CI' || v === undefined) continue;
    base[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }

  const result: SpawnSyncReturns<string> = spawnSync('node', [binPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: base,
    timeout: WATCHDOG_MS,
    // Give the child a pipe for stdin so nothing can block on a read.
    input: '',
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    signal: result.signal ?? null,
  };
}

interface ProbeSpec {
  method: 'GET' | 'POST';
  url: string;
  headerTemplate: Record<string, string>;
  expectStatus?: number[];
}

function writeManifest(
  root: string,
  entries: Array<{
    key: string;
    required?: boolean;
    format?: { pattern?: string; example?: string };
    verify?: ProbeSpec;
  }>,
): void {
  writeFileSync(
    join(root, 'env.schema.jsonc'),
    JSON.stringify(
      {
        version: 1,
        entries: entries.map((e) => ({
          key: e.key,
          description: `Fixture entry ${e.key}`,
          required: e.required ?? true,
          secret: true,
          sink: 'dotenv',
          ...(e.format ? { format: e.format } : {}),
          ...(e.verify ? { verify: { expectStatus: [200], ...e.verify } } : {}),
        })),
      },
      null,
      2,
    ),
  );
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'envseal-contract-'));
  writeFileSync(join(tempDir, '.gitignore'), '.env\n');
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* a still-open handle on Windows must not fail the assertion above */
  }
});

describe('fixture hygiene', () => {
  it('never points the CLI at the envseal repository', () => {
    expect(tempDir.startsWith(tmpdir())).toBe(true);
    expect(tempDir.toLowerCase().startsWith(repoRoot.toLowerCase())).toBe(false);
    expect(existsSync(binPath), `Binary not found at ${binPath}; run pnpm build`).toBe(true);
  });
});

describe('verify: exit 6 and no libuv abort (blocker B4)', () => {
  beforeEach(() => {
    writeManifest(tempDir, [
      {
        key: 'OPENAI_API_KEY',
        verify: {
          method: 'GET',
          url: 'https://api.openai.com/v1/models',
          headerTemplate: { Authorization: 'Bearer {{value}}' },
        },
      },
    ]);
    writeFileSync(join(tempDir, '.env'), 'OPENAI_API_KEY=sk-not-a-real-key-contract-test\n');
  });

  it(
    'exits 6 on five consecutive runs with no libuv assertion',
    { timeout: 180_000 },
    () => {
      const codes: number[] = [];
      const stderrs: string[] = [];

      for (let i = 0; i < 5; i++) {
        const r = runCli(tempDir, ['verify', '--project', tempDir, '--json']);
        codes.push(r.exitCode);
        stderrs.push(r.stderr);

        // Unconditional, one run at a time, so a single bad run names itself.
        expect(r.exitCode, `run ${i + 1} stderr: ${r.stderr}`).toBe(6);
        expect(r.exitCode).not.toBe(CRASH_EXIT);
        expect(r.signal).toBe(null);
        expect(r.stderr).not.toMatch(/Assertion failed/i);
        expect(r.stderr).not.toMatch(/UV_HANDLE_CLOSING/);

        // stdout must be intact, not truncated by an abort mid-write.
        const parsed = JSON.parse(r.stdout) as { allOk: boolean; results: unknown[] };
        expect(parsed.allOk).toBe(false);
        expect(parsed.results).toHaveLength(1);
      }

      expect(codes).toEqual([6, 6, 6, 6, 6]);
      expect(stderrs.join('')).toBe('');
    },
  );

  it('exits 0 when every probe passes', { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'envseal-contract-ok-'));
    try {
      // 401 is the expected status, so the probe is "ok" without a live credential.
      writeManifest(root, [
        {
          key: 'OPENAI_API_KEY',
          verify: {
            method: 'GET',
            url: 'https://api.openai.com/v1/models',
            headerTemplate: { Authorization: 'Bearer {{value}}' },
            expectStatus: [401],
          },
        },
      ]);
      writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-not-a-real-key\n');

      const r = runCli(root, ['verify', '--project', root, '--json']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).allOk).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('set: documented exit codes', () => {
  beforeEach(() => {
    writeManifest(tempDir, [{ key: 'CONTRACT_KEY' }]);
  });

  it('exits 0 and reports outcome=stored when the key is stored', () => {
    const r = runCli(tempDir, ['set', 'CONTRACT_KEY', '--project', tempDir, '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_VALUE: SENTINEL,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ key: 'CONTRACT_KEY', outcome: 'stored' });
    expect(r.stdout + r.stderr).not.toContain(SENTINEL);
    expect(readFileSync(join(tempDir, '.env'), 'utf8')).toContain('CONTRACT_KEY=');
  });

  it('exits 3 when the user cancels', () => {
    const r = runCli(tempDir, ['set', 'CONTRACT_KEY', '--project', tempDir, '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_OUTCOME: 'cancelled',
    });
    expect(r.exitCode, r.stderr).toBe(3);
    expect(JSON.parse(r.stdout).outcome).toBe('cancelled');
  });

  it('exits 3 when the prompt times out', () => {
    const r = runCli(tempDir, ['set', 'CONTRACT_KEY', '--project', tempDir, '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_OUTCOME: 'timeout',
    });
    expect(r.exitCode, r.stderr).toBe(3);
    expect(JSON.parse(r.stdout).outcome).toBe('timeout');
  });

  it('exits 1 when the key is skipped', () => {
    const r = runCli(tempDir, ['set', 'CONTRACT_KEY', '--project', tempDir, '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_OUTCOME: 'skipped',
    });
    expect(r.exitCode, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).outcome).toBe('skipped');
  });

  it('exits 1 when the value fails the declared format', () => {
    const root = mkdtempSync(join(tmpdir(), 'envseal-contract-fmt-'));
    try {
      writeManifest(root, [
        { key: 'CONTRACT_KEY', format: { pattern: '^sk-proj-[A-Za-z0-9]{20,}$' } },
      ]);
      const r = runCli(root, ['set', 'CONTRACT_KEY', '--project', root, '--json'], {
        ENVSEAL_TEST_MODE: '1',
        ENVSEAL_TEST_PROMPTER_VALUE: 'nope',
      });
      expect(r.exitCode, r.stderr).toBe(1);
      expect(JSON.parse(r.stdout).outcome).toBe('invalid_format');
      expect(existsSync(join(root, '.env'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 4 when there is no interactive surface', () => {
    const r = runCli(tempDir, ['set', 'CONTRACT_KEY', '--project', tempDir, '--json'], {
      CI: '1',
    });
    expect(r.exitCode, r.stderr).toBe(4);
    expect(JSON.parse(r.stdout).code).toBe('SEP_NO_INTERACTIVE_SURFACE');
    expect(r.signal).toBe(null);
  });

  it('exits 2 when KEY is missing', () => {
    const r = runCli(tempDir, ['set', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(2);
  });
});

// `set` declares before it requests, so every attempt that did not end
// `stored` used to leave the key behind in env.schema.jsonc as required+secret.
// A single typo then corrupted the manifest permanently: status shows the
// phantom forever, revoke touches only sinks, init does not prune.
describe('set: failed attempts leave no phantom declaration', () => {
  // File-level beforeEach wrote only .gitignore: this project starts WITHOUT a
  // manifest, exactly like the audited first-run experience.
  it('removes what it declared when nothing gets stored (CI, exit 4)', () => {
    const r = runCli(tempDir, ['set', 'FRESH_KEY', '--project', tempDir, '--json'], {
      CI: '1',
    });
    expect(r.exitCode, r.stderr).toBe(4);
    expect(JSON.parse(r.stdout).code).toBe('SEP_NO_INTERACTIVE_SURFACE');
    expect(readFileSync(join(tempDir, 'env.schema.jsonc'), 'utf8')).not.toContain('FRESH_KEY');
    // The mutation being undone must be announced, not silent.
    expect(r.stderr).toContain('declared FRESH_KEY but nothing was stored');
  });

  it('keeps unrelated entries while removing only the failed one', () => {
    writeManifest(tempDir, [{ key: 'KEEP_ME_KEY' }]);
    const r = runCli(tempDir, ['set', 'FRESH_KEY', '--project', tempDir, '--json'], {
      CI: '1',
    });
    expect(r.exitCode, r.stderr).toBe(4);
    const manifest = readFileSync(join(tempDir, 'env.schema.jsonc'), 'utf8');
    expect(manifest).toContain('KEEP_ME_KEY');
    expect(manifest).not.toContain('FRESH_KEY');
  });

  it('keeps a pre-existing declaration after a failed set', () => {
    writeManifest(tempDir, [{ key: 'PRE_EXISTING_KEY' }]);
    const r = runCli(
      tempDir,
      ['set', 'PRE_EXISTING_KEY', '--project', tempDir, '--json'],
      {
        ENVSEAL_TEST_MODE: '1',
        ENVSEAL_TEST_PROMPTER_OUTCOME: 'cancelled',
      },
    );
    expect(r.exitCode, r.stderr).toBe(3);
    expect(JSON.parse(r.stdout).outcome).toBe('cancelled');
    expect(readFileSync(join(tempDir, 'env.schema.jsonc'), 'utf8')).toContain('PRE_EXISTING_KEY');
    // The entry was not added by this run, so there is nothing to announce.
    expect(r.stderr).not.toContain('declaration removed');
  });

  it('still declares and stores on success', () => {
    const r = runCli(tempDir, ['set', 'SUCCESS_FRESH_KEY', '--project', tempDir, '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_VALUE: SENTINEL,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ key: 'SUCCESS_FRESH_KEY', outcome: 'stored' });
    expect(readFileSync(join(tempDir, 'env.schema.jsonc'), 'utf8')).toContain('SUCCESS_FRESH_KEY');
    expect(readFileSync(join(tempDir, '.env'), 'utf8')).toContain('SUCCESS_FRESH_KEY=');
  });
});

describe('ensure: documented exit codes', () => {
  beforeEach(() => {
    writeManifest(tempDir, [{ key: 'ENSURE_A' }, { key: 'ENSURE_B' }]);
  });

  it('exits 0 and reports total when everything is already satisfied', () => {
    writeFileSync(join(tempDir, '.env'), 'ENSURE_A=a-value\nENSURE_B=b-value\n');
    const r = runCli(tempDir, ['ensure', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(0);
    // `total` was missing on this path entirely, so a caller reading it got
    // undefined on the most common outcome.
    expect(JSON.parse(r.stdout)).toEqual({ satisfied: true, keysSet: 0, total: 0 });
  });

  it('exits 0 after collecting every missing key', () => {
    const r = runCli(tempDir, ['ensure', '--project', tempDir, '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_VALUE: SENTINEL,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ satisfied: true, keysSet: 2, total: 2 });
    expect(r.stdout + r.stderr).not.toContain(SENTINEL);
  });

  it('exits 3 when the user cancels', () => {
    const r = runCli(tempDir, ['ensure', '--project', tempDir, '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_OUTCOME: 'cancelled',
    });
    expect(r.exitCode, r.stderr).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({ satisfied: false, keysSet: 0, total: 2 });
  });

  it('exits 1 when keys are skipped rather than refused', () => {
    const r = runCli(tempDir, ['ensure', '--project', tempDir, '--json'], {
      ENVSEAL_TEST_MODE: '1',
      ENVSEAL_TEST_PROMPTER_OUTCOME: 'skipped',
    });
    expect(r.exitCode, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ satisfied: false, keysSet: 0, total: 2 });
  });

  it('exits 4 when there is no interactive surface', () => {
    const r = runCli(tempDir, ['ensure', '--project', tempDir, '--json'], { CI: '1' });
    expect(r.exitCode, r.stderr).toBe(4);
    expect(JSON.parse(r.stdout).code).toBe('SEP_NO_INTERACTIVE_SURFACE');
    expect(r.signal).toBe(null);
  });
});

// No manifest means NOTHING is declared. describe() used to read that as an
// empty manifest — zero missing keys — and ensure reported vacuous success with
// exit 0 while doctor on the same project reported missing declarations.
describe('ensure: uninitialized project', () => {
  // No writeManifest here: the fixture stays manifest-less.
  it('exits 2 with guidance instead of a vacuous success', () => {
    const r = runCli(tempDir, ['ensure', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(2);
    const parsed = JSON.parse(r.stdout) as { code: string; userMessage: string };
    expect(parsed.code).toBe('SEP_NOT_DECLARED');
    expect(parsed.userMessage).toContain('No env.schema.jsonc');
    expect(parsed.userMessage).toContain('envseal init');
  });

  it('human output carries the same guidance on stderr', () => {
    const r = runCli(tempDir, ['ensure', '--project', tempDir]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('No env.schema.jsonc in this project (or parents)');
    expect(r.stdout).toBe('');
  });
});

describe('revoke: documented exit codes', () => {
  beforeEach(() => {
    writeManifest(tempDir, [{ key: 'REVOKE_ME' }]);
  });

  it('exits 0 when the key is removed', () => {
    writeFileSync(join(tempDir, '.env'), 'REVOKE_ME=some-value\n');
    const r = runCli(tempDir, ['revoke', 'REVOKE_ME', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).removed).toBe(true);
    expect(readFileSync(join(tempDir, '.env'), 'utf8')).not.toContain('REVOKE_ME=');
  });

  it('exits 1 when the key was declared but nothing was stored', () => {
    const r = runCli(tempDir, ['revoke', 'REVOKE_ME', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).removed).toBe(false);
  });

  it('exits 1 when the key is not in the manifest at all', () => {
    const r = runCli(tempDir, ['revoke', 'NEVER_DECLARED', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      key: 'NEVER_DECLARED',
      removed: false,
      rotateUrl: null,
    });
  });

  it('exits 2 when KEY is missing', () => {
    const r = runCli(tempDir, ['revoke', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(2);
  });
});

describe('run: documented exit codes', () => {
  beforeEach(() => {
    writeManifest(tempDir, [{ key: 'RUN_KEY' }]);
    writeFileSync(join(tempDir, '.env'), 'RUN_KEY=run-value\n');
  });

  it('exits 2 when -- is missing', () => {
    const r = runCli(tempDir, ['run', '--project', tempDir, 'node', '-e', '0']);
    expect(r.exitCode, r.stderr).toBe(2);
  });

  it('exits 2 when -- is present with no command after it', () => {
    const r = runCli(tempDir, ['run', '--project', tempDir, '--']);
    expect(r.exitCode, r.stderr).toBe(2);
  });

  it('exits 4 with no terminal to confirm on', () => {
    const r = runCli(tempDir, ['run', '--project', tempDir, '--json', '--', 'node', '-e', '0'], {
      CI: '1',
    });
    expect(r.exitCode, r.stderr).toBe(4);
    expect(JSON.parse(r.stdout).code).toBe('SEP_NO_INTERACTIVE_SURFACE');
    expect(r.signal).toBe(null);
  });

  it('passes the child exit code through when confirmed with --yes', { timeout: 30_000 }, () => {
    const r = runCli(tempDir, [
      'run',
      '--project',
      tempDir,
      '--yes',
      '--',
      'node',
      '-e',
      'process.exit(7)',
    ]);
    expect(r.exitCode, r.stderr).toBe(7);
  });
});

describe('status and doctor: documented exit codes', () => {
  it('status exits 1 while a required key is missing and 0 once present', () => {
    writeManifest(tempDir, [{ key: 'STATUS_KEY' }]);
    expect(runCli(tempDir, ['status', '--project', tempDir, '--json']).exitCode).toBe(1);

    writeFileSync(join(tempDir, '.env'), 'STATUS_KEY=value\n');
    expect(runCli(tempDir, ['status', '--project', tempDir, '--json']).exitCode).toBe(0);
  });

  it('doctor exits 1 while a required key is missing and 0 once present', () => {
    writeManifest(tempDir, [{ key: 'DOCTOR_KEY' }]);
    expect(runCli(tempDir, ['doctor', '--project', tempDir, '--json']).exitCode).toBe(1);

    writeFileSync(join(tempDir, '.env'), 'DOCTOR_KEY=value\n');
    expect(runCli(tempDir, ['doctor', '--project', tempDir, '--json']).exitCode).toBe(0);
  });

  it('exits 2 on an unknown command', () => {
    expect(runCli(tempDir, ['not-a-command', '--project', tempDir]).exitCode).toBe(2);
  });
});
