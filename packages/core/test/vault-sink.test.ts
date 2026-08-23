import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSecret, SepError } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import type { ProjectPaths } from '../src/paths.js';
import { VaultSink, vaultSink } from '../src/sinks/vault.js';
import { CliCommandFailure, execCli } from '../src/sinks/cli-sink-base.js';
import type { CliExecOptions, CliExecResult } from '../src/sinks/cli-sink-base.js';

// ASCII with punctuation: everything the stdin/stdout pipes carry byte-exact.
const VALUE = 'sk-vault-Kc7#pQz!9Rd-_2Wx/4Yv+6Zt=8Nb';

function commandAvailable(cmd: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(checker, [cmd], { stdio: 'ignore' }).status === 0;
}

const vaultInstalled = commandAvailable('vault');
// Live round-trips additionally need somewhere to talk to.
const liveReady = vaultInstalled && Boolean(process.env.VAULT_ADDR);

/** Same project scoping the sink uses: the leaf of the project root. */
function projectIdOf(paths: ProjectPaths): string {
  return paths.root.split(/[\\/]/).pop() ?? 'unknown';
}

function cliFailure(code: number, stderr: string): CliCommandFailure {
  return new CliCommandFailure(`vault exited with code ${code}: ${stderr}`, 'vault', code, stderr);
}

/** Unwraps a rejection as a SepError, failing the test loudly otherwise. */
async function sepFrom(operation: Promise<unknown>): Promise<SepError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SepError);
    return error as SepError;
  }
  throw new Error('expected the operation to reject, but it resolved');
}

/**
 * The scripted harness substitutes the provider at the sink's single spawn
 * choke point instead of staging a binary on PATH. It exists because Windows
 * cannot spawn shebang scripts (and modern Node refuses .bat/.cmd without a
 * shell), so a PATH-only double would leave the argv construction and
 * exit-code mapping unexercised on exactly the platform this repo is
 * developed on. requiredCommands is emptied so the harness is deterministic
 * on every machine; the real prerequisite probe is covered by the suites
 * below that drive the unmodified vaultSink.
 */
class ScriptedVaultSink extends VaultSink {
  lastArgs: readonly string[] = [];
  lastInput: string | undefined;

  protected override readonly requiredCommands: readonly string[] = [];

  respond: ((args: readonly string[]) => Promise<CliExecResult>) | null = null;

  protected override run(args: readonly string[], options: CliExecOptions = {}): Promise<CliExecResult> {
    this.lastArgs = args;
    this.lastInput = options.input;
    if (this.respond) return this.respond(args);
    return super.run(args, options);
  }
}

/**
 * A fake `vault` for the POSIX suite: logs its argv so assertions can prove
 * values stay off it, captures its stdin bytes, and replays canned outcomes
 * driven by FAKE_VAULT_* variables the tests set. Outcomes default to the
 * documented CLI behavior — "No value found" exit 2 for a missing read, a
 * success line for put/delete — so the suite doubles as the executable
 * record of the behavior vault.ts encodes.
 */
const FAKE_VAULT_SH = [
  '#!/bin/sh',
  '# Fake vault CLI for vault-sink.test.ts — see the suite comment there.',
  'echo "$*" >> "$FAKE_VAULT_LOG"',
  'case "$1:$2" in',
  '  kv:put)',
  '    cat > "$FAKE_VAULT_STDIN"',
  '    if [ -n "${FAKE_VAULT_PUT_EXIT:-}" ] && [ "${FAKE_VAULT_PUT_EXIT}" != "0" ]; then',
  '      echo "${FAKE_VAULT_PUT_ERR:-put failed}" >&2',
  '      exit "$FAKE_VAULT_PUT_EXIT"',
  '    fi',
  '    echo "${FAKE_VAULT_PUT_OUT:-Success! Data written to: secret/data/envseal/x}"',
  '    ;;',
  '  kv:get)',
  '    if [ -n "${FAKE_VAULT_GET_EXIT:-}" ] && [ "${FAKE_VAULT_GET_EXIT}" != "0" ]; then',
  '      echo "${FAKE_VAULT_GET_ERR:-No value found at secret/data/envseal/x}" >&2',
  '      exit "$FAKE_VAULT_GET_EXIT"',
  '    fi',
  '    echo "$FAKE_VAULT_VALUE"',
  '    ;;',
  '  kv:delete)',
  '    if [ -n "${FAKE_VAULT_DEL_EXIT:-}" ] && [ "${FAKE_VAULT_DEL_EXIT}" != "0" ]; then',
  '      echo "${FAKE_VAULT_DEL_ERR:-No value found at secret/data/envseal/x}" >&2',
  '      exit "$FAKE_VAULT_DEL_EXIT"',
  '    fi',
  '    echo "Success! Data deleted (if it existed) at: secret/data/envseal/x"',
  '    ;;',
  '  *)',
  '    echo "fake vault: unexpected invocation: $*" >&2',
  '    exit 64',
  '    ;;',
  'esac',
].join('\n');

describe('vault sink', () => {
  // Every suite below mutates provider configuration; nothing leaks past the
  // file because vitest runs files in separate processes, but within the file
  // the pristine values must survive.
  const SAVED_KEYS = ['VAULT_ADDR', 'ENVSEAL_VAULT_MOUNT', 'PATH'] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const name of SAVED_KEYS) savedEnv[name] = process.env[name];
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('FAKE_VAULT_')) delete process.env[name];
    }
    for (const name of SAVED_KEYS) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('scripted CLI harness (all platforms)', () => {
    let sink: ScriptedVaultSink;
    let paths: ProjectPaths;

    beforeEach(() => {
      sink = new ScriptedVaultSink();
      paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-vt-')));
      process.env.VAULT_ADDR = 'http://127.0.0.1:8200';
    });

    afterEach(() => {
      rmSync(paths.root, { recursive: true, force: true });
    });

    it('available() demands VAULT_ADDR on top of the CLI probe', async () => {
      process.env.VAULT_ADDR = 'http://127.0.0.1:8200';
      expect(await sink.available(paths)).toBe(true);
      delete process.env.VAULT_ADDR;
      expect(await sink.available(paths)).toBe(false);
    });

    it('read shells out with the documented kv get form', async () => {
      sink.respond = async () => ({ stdout: 'v\n', stderr: '' });
      await sink.read(paths, 'API_KEY');
      expect(sink.lastArgs).toEqual([
        'kv',
        'get',
        '-field',
        'API_KEY',
        '-mount',
        'secret',
        `envseal/${projectIdOf(paths)}/API_KEY`,
      ]);
    });

    it('read strips exactly one trailing newline, byte-exact', async () => {
      sink.respond = async () => ({ stdout: 'a\nb\n\n', stderr: '' });
      const value = await sink.read(paths, 'API_KEY');
      expect(value?.toString('utf8')).toBe('a\nb\n');
    });

    it('read maps exit 2 "No value found" to null', async () => {
      sink.respond = async () => {
        throw cliFailure(2, 'No value found at secret/data/envseal/x');
      };
      expect(await sink.read(paths, 'API_KEY')).toBeNull();
    });

    it('read refuses to mistake a forbidden path (exit 2, other stderr) for absence', async () => {
      sink.respond = async () => {
        throw cliFailure(2, 'Error reading secret/data/envseal/x: permission denied');
      };
      const error = await sepFrom(sink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
    });

    it('read maps a generic failure to SEP_SINK_WRITE_FAILED with vault diagnostics', async () => {
      sink.respond = async () => {
        throw cliFailure(1, 'connection refused');
      };
      const error = await sepFrom(sink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
      expect(error.details).toMatchObject({ sink: 'vault', operation: 'read', exitCode: 1 });
    });

    it('write passes the value through stdin, never argv', async () => {
      sink.respond = async () => ({ stdout: '', stderr: '' });
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      expect(sink.lastArgs).toEqual([
        'kv',
        'put',
        '-mount',
        'secret',
        `envseal/${projectIdOf(paths)}/API_KEY`,
        'API_KEY=-',
      ]);
      expect(sink.lastInput).toBe(VALUE);
    });

    it('two keys in one project target distinct server-side paths (kv put replaces whole paths)', async () => {
      const calls: ReadonlyArray<string>[] = [];
      sink.respond = async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      };
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      await sink.write(paths, 'DB_PASSWORD', asSecret(Buffer.from(VALUE, 'utf8')));
      // kv put REPLACES the data map at its target path, so a shared project
      // path would make the second write silently destroy the first key; kv
      // delete removes the whole path too, so remove() must aim at one only.
      const scope = `envseal/${projectIdOf(paths)}`;
      expect(calls[0]).toEqual(['kv', 'put', '-mount', 'secret', `${scope}/API_KEY`, 'API_KEY=-']);
      expect(calls[1]).toEqual([
        'kv',
        'put',
        '-mount',
        'secret',
        `${scope}/DB_PASSWORD`,
        'DB_PASSWORD=-',
      ]);
      await sink.remove(paths, 'API_KEY');
      expect(calls[2]).toEqual(['kv', 'delete', '-mount', 'secret', `${scope}/API_KEY`]);
    });

    it('write maps a CLI failure to SEP_SINK_WRITE_FAILED', async () => {
      sink.respond = async () => {
        throw cliFailure(2, 'permission denied');
      };
      const error = await sepFrom(sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8'))));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
      expect(error.details).toMatchObject({ sink: 'vault', operation: 'write' });
    });

    it('ENVSEAL_VAULT_MOUNT overrides the mount for every operation', async () => {
      process.env.ENVSEAL_VAULT_MOUNT = 'kv-proj';
      const seen: ReadonlyArray<string>[] = [];
      sink.respond = async (args) => {
        seen.push(args);
        return { stdout: '', stderr: '' };
      };
      const secret = asSecret(Buffer.from(VALUE, 'utf8'));
      await sink.write(paths, 'API_KEY', secret);
      await sink.read(paths, 'API_KEY');
      await sink.remove(paths, 'API_KEY');
      expect(seen).toHaveLength(3);
      expect(seen.map((args) => args[args.indexOf('-mount') + 1])).toEqual([
        'kv-proj',
        'kv-proj',
        'kv-proj',
      ]);
    });

    it('remove reports true on success and maps the absence code to false', async () => {
      sink.respond = async () => ({ stdout: 'Success! Data deleted (if it existed)\n', stderr: '' });
      expect(await sink.remove(paths, 'API_KEY')).toBe(true);
      expect(sink.lastArgs).toEqual([
        'kv',
        'delete',
        '-mount',
        'secret',
        `envseal/${projectIdOf(paths)}/API_KEY`,
      ]);
      sink.respond = async () => {
        throw cliFailure(2, 'No value found at secret/data/envseal/x');
      };
      expect(await sink.remove(paths, 'API_KEY')).toBe(false);
    });

    it('remove maps a real failure to SEP_SINK_WRITE_FAILED', async () => {
      sink.respond = async () => {
        throw cliFailure(1, 'permission denied');
      };
      const error = await sepFrom(sink.remove(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
      expect(error.details).toMatchObject({ sink: 'vault', operation: 'remove' });
    });

    it('a binary that vanishes between probe and spawn is unavailability, not failure', async () => {
      sink.respond = async () => {
        throw Object.assign(new Error('spawn vault ENOENT'), { code: 'ENOENT' });
      };
      const error = await sepFrom(sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8'))));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
    });

    it('an unexpected non-CLI error still fails loudly', async () => {
      sink.respond = async () => {
        throw new Error('boom');
      };
      const error = await sepFrom(sink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
    });

    it('operations refuse with a VAULT_ADDR-naming error when the address is unset', async () => {
      delete process.env.VAULT_ADDR;
      const error = await sepFrom(sink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('VAULT_ADDR');
    });
  });

  // Exercises the unmodified sink through the real exec pipeline — PATH probe,
  // spawn, stdin delivery, stdout parsing — against a staged fake binary.
  describe.skipIf(process.platform === 'win32')('fake vault CLI on PATH (POSIX)', () => {
    let binDir: string;
    let paths: ProjectPaths;
    let logFile: string;
    let stdinFile: string;

    beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), 'envseal-vaultfake-'));
      paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-vt-')));
      logFile = join(binDir, 'invocations.log');
      stdinFile = join(binDir, 'last-stdin');
      writeFileSync(join(binDir, 'vault'), FAKE_VAULT_SH, { mode: 0o755 });
      chmodSync(join(binDir, 'vault'), 0o755);
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
      process.env.VAULT_ADDR = 'http://127.0.0.1:8200';
      process.env.FAKE_VAULT_LOG = logFile;
      process.env.FAKE_VAULT_STDIN = stdinFile;
      process.env.FAKE_VAULT_VALUE = VALUE;
    });

    afterEach(() => {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(paths.root, { recursive: true, force: true });
    });

    it('available() sees the staged CLI and address', async () => {
      expect(await vaultSink.available(paths)).toBe(true);
    });

    it('write then read round-trips, value on stdin only', async () => {
      await vaultSink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      expect(readFileSync(stdinFile, 'utf8')).toBe(VALUE);
      const argvLog = readFileSync(logFile, 'utf8');
      expect(argvLog).not.toContain(VALUE);
      const firstLine = argvLog.split('\n')[0];
      expect(firstLine).toBe(
        `kv put -mount secret envseal/${projectIdOf(paths)}/API_KEY API_KEY=-`,
      );

      const read = await vaultSink.read(paths, 'API_KEY');
      expect(read?.toString('utf8')).toBe(VALUE);
    });

    it('read maps the fake exit-2 "No value found" to null', async () => {
      process.env.FAKE_VAULT_GET_EXIT = '2';
      expect(await vaultSink.read(paths, 'API_KEY')).toBeNull();
    });

    it('read refuses to mistake exit-2 permission denial for absence', async () => {
      process.env.FAKE_VAULT_GET_EXIT = '2';
      process.env.FAKE_VAULT_GET_ERR = 'Error reading secret/data/envseal/x: permission denied';
      const error = await sepFrom(vaultSink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
    });

    it('read maps a generic failure to SEP_SINK_WRITE_FAILED', async () => {
      process.env.FAKE_VAULT_GET_EXIT = '1';
      process.env.FAKE_VAULT_GET_ERR = 'connection refused';
      const error = await sepFrom(vaultSink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
    });

    it('remove reports true on success and false on the absence code', async () => {
      expect(await vaultSink.remove(paths, 'API_KEY')).toBe(true);
      process.env.FAKE_VAULT_DEL_EXIT = '2';
      expect(await vaultSink.remove(paths, 'API_KEY')).toBe(false);
      process.env.FAKE_VAULT_DEL_EXIT = '1';
      process.env.FAKE_VAULT_DEL_ERR = 'permission denied';
      const error = await sepFrom(vaultSink.remove(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
    });
  });

  // Live behavior on a machine where the CLI is genuinely absent — the state
  // this repo is developed under. These are real assertions, not skips: if
  // the sink ever stops degrading to false/SEP_SINK_UNAVAILABLE, they fail.
  describe.skipIf(vaultInstalled)('vault CLI missing (this machine)', () => {
    let paths: ProjectPaths;

    beforeEach(() => {
      paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-vt-')));
      // Address present on purpose: ONLY the missing CLI may trigger these.
      process.env.VAULT_ADDR = 'http://127.0.0.1:8200';
    });

    afterEach(() => {
      rmSync(paths.root, { recursive: true, force: true });
    });

    it('available() is false', async () => {
      expect(await vaultSink.available(paths)).toBe(false);
    });

    it('read refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
      const error = await sepFrom(vaultSink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('vault CLI is not installed');
    });

    it('write refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
      const error = await sepFrom(vaultSink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8'))));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('vault CLI is not installed');
    });

    it('remove refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
      const error = await sepFrom(vaultSink.remove(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('vault CLI is not installed');
    });
  });

  // Deterministic on every machine: with the address unset, available() must
  // be false and every operation must refuse — via the CLI branch where the
  // binary is missing, via the VAULT_ADDR branch where it exists.
  describe('VAULT_ADDR unset (all machines)', () => {
    let paths: ProjectPaths;

    beforeEach(() => {
      paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-vt-')));
      delete process.env.VAULT_ADDR;
    });

    afterEach(() => {
      rmSync(paths.root, { recursive: true, force: true });
    });

    it('available() is false', async () => {
      expect(await vaultSink.available(paths)).toBe(false);
    });

    it('read refuses with SEP_SINK_UNAVAILABLE', async () => {
      const error = await sepFrom(vaultSink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('VAULT_ADDR');
    });

    it('write refuses with SEP_SINK_UNAVAILABLE', async () => {
      const error = await sepFrom(vaultSink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8'))));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('VAULT_ADDR');
    });

    it('remove refuses with SEP_SINK_UNAVAILABLE', async () => {
      const error = await sepFrom(vaultSink.remove(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('VAULT_ADDR');
    });
  });

  // The only suite that talks to a real server. It encodes the documented
  // absence semantics the other suites simulate, and cleans its throwaway
  // scope off the server afterwards.
  describe.skipIf(!liveReady)('live vault round-trip (requires vault + VAULT_ADDR)', () => {
    let paths: ProjectPaths;
    let key: string;

    beforeEach(() => {
      // Unique leaf per run: the sink scopes by project basename, so a fresh
      // temp dir is a fresh server-side scope with no cross-run collisions.
      paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-vault-live-')));
      key = `ENVSEAL_TEST_${randomBytes(6).toString('hex').toUpperCase()}`;
    });

    afterEach(async () => {
      // kv delete only soft-deletes; metadata delete drops the throwaway
      // key's path entirely so the suite leaves no residue on the server.
      const mount = process.env.ENVSEAL_VAULT_MOUNT ?? 'secret';
      await execCli('vault', [
        'kv',
        'metadata',
        'delete',
        '-mount',
        mount,
        `envseal/${projectIdOf(paths)}/${key}`,
      ]).catch(() => {
        // ignore — cleanup must never mask a test failure
      });
      rmSync(paths.root, { recursive: true, force: true });
    });

    it('read on a never-written path returns null (documented absence semantics)', async () => {
      expect(await vaultSink.read(paths, key)).toBeNull();
    });

    it('write then read round-trips the value', async () => {
      await vaultSink.write(paths, key, asSecret(Buffer.from(VALUE, 'utf8')));
      const read = await vaultSink.read(paths, key);
      expect(read?.toString('utf8')).toBe(VALUE);
    });

    it('remove deletes the entry, then read returns null', async () => {
      await vaultSink.write(paths, key, asSecret(Buffer.from(VALUE, 'utf8')));
      expect(await vaultSink.remove(paths, key)).toBe(true);
      expect(await vaultSink.read(paths, key)).toBeNull();
      // No assertion on a second remove(): current servers report success
      // ("if it existed") even when nothing was there, so the boolean is
      // server-version-dependent — asserting it would make this suite flaky
      // rather than meaningful.
    });
  });
});
