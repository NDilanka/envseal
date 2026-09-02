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

function writeLayer1(root: string): void {
  writeFileSync(
    join(root, 'AGENTS.md'),
    'This repository uses envseal. Never read .env. Use envseal ensure and envseal run -- instead.\n',
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
        { key: 'CONTRACT_KEY', format: { pattern: '^sk-proj-[A-Za-z0-9]{20,80}$' } },
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

// --check is the headless gate: it reports and exits without ever opening a
// ticket. Each case pins that by exit code alone — a stray request under CI
// would exit 4, a stray request over a piped stdin would too, and a prompt
// would hit the 20s watchdog.
describe('ensure --check: report, never prompt', () => {
  beforeEach(() => {
    writeManifest(tempDir, [{ key: 'CHECK_A' }, { key: 'CHECK_B', required: false }]);
  });

  it('exits 0 satisfied under CI when required keys are present', () => {
    writeFileSync(join(tempDir, '.env'), 'CHECK_A=present\n');
    const r = runCli(tempDir, ['ensure', '--check', '--project', tempDir, '--json'], { CI: '1' });
    expect(r.exitCode, r.stderr).toBe(0);
    // Optional entries are not part of the gate: total counts required only.
    expect(JSON.parse(r.stdout)).toEqual({
      satisfied: true,
      keysSet: 1,
      total: 1,
      missing: [],
    });
  });

  it('exits 1 with the missing key list under CI — no prompting, exit 4, or hang', () => {
    const r = runCli(tempDir, ['ensure', '--check', '--project', tempDir, '--json'], { CI: '1' });
    expect(r.exitCode, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      satisfied: false,
      keysSet: 0,
      total: 1,
      missing: ['CHECK_A'],
    });
  });

  it('does not prompt even without CI (piped stdin would make a request exit 4)', () => {
    const r = runCli(tempDir, ['ensure', '--check', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).satisfied).toBe(false);
  });

  it('human output names the missing keys', () => {
    const r = runCli(tempDir, ['ensure', '--check', '--project', tempDir]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('1 of 1 required key(s) missing');
    expect(r.stdout).toContain('CHECK_A');
    expect(r.stdout).not.toContain('CHECK_B');
  });

  it('keeps the exit-2 honesty on a project with no manifest', () => {
    rmSync(join(tempDir, 'env.schema.jsonc'));
    const r = runCli(tempDir, ['ensure', '--check', '--project', tempDir, '--json'], { CI: '1' });
    expect(r.exitCode, r.stderr).toBe(2);
    expect(JSON.parse(r.stdout).code).toBe('SEP_NOT_DECLARED');
  });
});

describe('revoke: documented exit codes', () => {
  beforeEach(() => {
    writeManifest(tempDir, [{ key: 'REVOKE_ME' }]);
  });

  it('exits 0 when the key is removed', () => {
    writeFileSync(join(tempDir, '.env'), 'REVOKE_ME=some-value\n');
    const r = runCli(tempDir, ['revoke', 'REVOKE_ME', '--project', tempDir, '--yes', '--json']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).removed).toBe(true);
    expect(readFileSync(join(tempDir, '.env'), 'utf8')).not.toContain('REVOKE_ME=');
  });

  it('exits 1 when the key was declared but nothing was stored', () => {
    const r = runCli(tempDir, ['revoke', 'REVOKE_ME', '--project', tempDir, '--yes', '--json']);
    expect(r.exitCode, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).removed).toBe(false);
  });

  it('exits 1 when the key is not in the manifest at all', () => {
    const r = runCli(tempDir, ['revoke', 'NEVER_DECLARED', '--project', tempDir, '--yes', '--json']);
    expect(r.exitCode, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      key: 'NEVER_DECLARED',
      removed: false,
      rotateUrl: null,
    });
  });

  it('exits 4 with no terminal to confirm on', () => {
    writeFileSync(join(tempDir, '.env'), 'REVOKE_ME=some-value\n');
    const r = runCli(tempDir, ['revoke', 'REVOKE_ME', '--project', tempDir, '--json'], {
      CI: '1',
    });
    expect(r.exitCode, r.stderr).toBe(4);
    expect(JSON.parse(r.stdout).code).toBe('SEP_NO_INTERACTIVE_SURFACE');
    expect(r.signal).toBe(null);
    expect(readFileSync(join(tempDir, '.env'), 'utf8')).toContain('REVOKE_ME=');
  });

  it('exits 0 with ENVSEAL_ASSUME_YES=1 and no TTY', () => {
    writeFileSync(join(tempDir, '.env'), 'REVOKE_ME=some-value\n');
    const r = runCli(tempDir, ['revoke', 'REVOKE_ME', '--project', tempDir, '--json'], {
      CI: '1',
      ENVSEAL_ASSUME_YES: '1',
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).removed).toBe(true);
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
    writeLayer1(tempDir);
    expect(runCli(tempDir, ['doctor', '--project', tempDir, '--json']).exitCode).toBe(1);

    writeFileSync(join(tempDir, '.env'), 'DOCTOR_KEY=value\n');
    expect(runCli(tempDir, ['doctor', '--project', tempDir, '--json']).exitCode).toBe(0);
  });

  it('doctor gitignore.covers uses ignore semantics, not substring match', () => {
    writeManifest(tempDir, [{ key: 'GITIGNORE_KEY' }]);
    writeLayer1(tempDir);
    writeFileSync(join(tempDir, '.env'), 'GITIGNORE_KEY=value\n');
    writeFileSync(join(tempDir, '.gitignore'), 'my.env.backup\n');

    const r = runCli(tempDir, ['doctor', '--project', tempDir, '--json']);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as { gitignore: { covers: boolean } };
    expect(parsed.gitignore.covers).toBe(false);
  });

  it('doctor reports hookFailClosed from ENVSEAL_HOOK_FAIL_CLOSED', () => {
    writeManifest(tempDir, [{ key: 'HOOK_KEY' }]);
    writeLayer1(tempDir);
    writeFileSync(join(tempDir, '.env'), 'HOOK_KEY=value\n');

    const openDefault = runCli(tempDir, ['doctor', '--project', tempDir, '--json']);
    expect(openDefault.exitCode, openDefault.stderr).toBe(0);
    expect(JSON.parse(openDefault.stdout).hookFailClosed).toBe(false);

    const failClosed = runCli(tempDir, ['doctor', '--project', tempDir, '--json'], {
      ENVSEAL_HOOK_FAIL_CLOSED: '1',
    });
    expect(failClosed.exitCode, failClosed.stderr).toBe(0);
    expect(JSON.parse(failClosed.stdout).hookFailClosed).toBe(true);
  });

  it('exits 2 on an unknown command', () => {
    expect(runCli(tempDir, ['not-a-command', '--project', tempDir]).exitCode).toBe(2);
  });
});

// A help request used to be indistinguishable from a run: `ensure -h` executed
// the real command (exit 4 under CI) and interactive `set --help` reached the
// live browser prompt. Help must describe the command and do nothing else.
describe('help: -h/--help describes without executing', () => {
  it('ensure -h prints usage and exits 0 instead of running under CI', () => {
    writeManifest(tempDir, [{ key: 'HELP_ENSURE_KEY' }]);
    const r = runCli(tempDir, ['ensure', '-h', '--project', tempDir], { CI: '1' });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('envseal ensure');
    expect(r.stdout).toContain('--check');
    // The command did not run: no outcome object, no missing-surface complaint.
    expect(r.stdout).not.toContain('satisfied');
    expect(r.stdout + r.stderr).not.toContain('SEP_NO_INTERACTIVE_SURFACE');
  });

  it('set --help prints usage, exits 0, and leaves no manifest behind', () => {
    const r = runCli(tempDir, ['set', '--help', '--project', tempDir], { CI: '1' });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('envseal set');
    // `set` declares before it requests: had the command executed at all, even
    // its failure paths would have created env.schema.jsonc here.
    expect(existsSync(join(tempDir, 'env.schema.jsonc'))).toBe(false);
  });
});

// --host used to accept any string silently, and a claude-code first run ended
// at a manifest with no word on connecting the agent to the broker.
describe('init: --host validation and first-run guidance', () => {
  it('rejects an unknown host with exit 2, listing the valid values', () => {
    const r = runCli(tempDir, ['init', '--host', 'vscode', '--project', tempDir]);
    expect(r.exitCode, r.stdout).toBe(2);
    expect(r.stderr).toContain("unknown --host 'vscode'");
    expect(r.stderr).toContain(
      'claude-code, cursor, continue, aider, windsurf, cline, zed, codex, jetbrains, goose, copilot, generic, unknown, openhands',
    );
    // Rejected before any filesystem work: no manifest may appear.
    expect(existsSync(join(tempDir, 'env.schema.jsonc'))).toBe(false);
  });

  it('prints the MCP connection step for claude-code and writes .mcp.json', () => {
    const r = runCli(tempDir, ['init', '--host', 'claude-code', '--project', tempDir]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('.mcp.json');
    expect(r.stdout).toContain('envseal-mcp');
    expect(r.stdout).toMatch(/restart Claude Code/i);
    expect(r.stdout).not.toMatch(/protection tier A\b/i);
    expect(existsSync(join(tempDir, '.mcp.json'))).toBe(true);
    const mcp = JSON.parse(readFileSync(join(tempDir, '.mcp.json'), 'utf8')) as {
      mcpServers: { 'envseal-mcp': { command: string; args: string[] } };
    };
    expect(mcp.mcpServers['envseal-mcp'].args).toEqual(['-y', '@envseal/mcp-server']);
    expect(['npx', 'npx.cmd']).toContain(mcp.mcpServers['envseal-mcp'].command);
  });

  it('notes that an override may differ from what detection reports', () => {
    const r = runCli(tempDir, ['init', '--host', 'cursor', '--project', tempDir]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('Override recorded; envseal doctor reports what is actually detected.');
    expect(r.stdout).toContain('Reload MCP in Settings → MCP');
    const mcp = JSON.parse(readFileSync(join(tempDir, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: { 'envseal-mcp': { command: string; args: string[] } };
    };
    expect(mcp.mcpServers['envseal-mcp'].args).toEqual(['-y', '@envseal/mcp-server']);
    expect(['npx', 'npx.cmd']).toContain(mcp.mcpServers['envseal-mcp'].command);
  });
});
