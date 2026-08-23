import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { asSecret, SepError } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import type { ProjectPaths } from '../src/paths.js';
import { SopsSink, sopsSink } from '../src/sinks/sops.js';
import { CliCommandFailure } from '../src/sinks/cli-sink-base.js';
import type { CliExecOptions, CliExecResult } from '../src/sinks/cli-sink-base.js';

// ASCII with punctuation: everything the staged files carry byte-exact.
const VALUE = 'sk-sops-Kc7#pQz!9Rd-_2Wx/4Yv+6Zt=8Nb';

function commandAvailable(cmd: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(checker, [cmd], { stdio: 'ignore' }).status === 0;
}

const sopsInstalled = commandAvailable('sops');

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
 * The fake cipher both harnesses use: line-prefix tagging with base64 bodies.
 * It is NOT real sops output — it exists so the encrypt/decrypt invocation
 * forms, the staged-file plumbing, and the parsing logic get exercised
 * without a provider binary. Real-format behavior is sops' own contract and
 * is covered by the live suite where an identity exists.
 */
function fakeEncrypt(plaintext: string): string {
  return plaintext
    .split('\n')
    .map((line) => (line.trim() === '' || !line.includes(':') ? line : `ENCFAKE[${Buffer.from(line).toString('base64')}]`))
    .join('\n');
}

function fakeDecrypt(ciphertext: string): string {
  return ciphertext
    .split('\n')
    .map((line) => {
      const m = /^ENCFAKE\[(.*)\]$/.exec(line.trim());
      return m === null ? line : Buffer.from(m[1], 'base64').toString('utf8');
    })
    .join('\n');
}

/**
 * Substitutes the provider at the sink's single spawn choke point (see
 * vault-sink.test.ts for why PATH-staging alone cannot work on Windows).
 * requiredCommands is emptied so suites are deterministic everywhere; the
 * real binary probe is asserted by the missing-CLI suite driving the
 * unmodified sopsSink below.
 */
class ScriptedSopsSink extends SopsSink {
  readonly calls: ReadonlyArray<string>[] = [];

  protected override readonly requiredCommands: readonly string[] = [];

  respond: ((args: readonly string[]) => Promise<CliExecResult>) | null = null;

  protected override run(args: readonly string[], options: CliExecOptions = {}): Promise<CliExecResult> {
    this.calls.push(args);
    void options;
    if (this.respond) return this.respond(args);
    // Faithful fake: encrypt/decrypt the staged file in place like real sops.
    const target = args[args.length - 1];
    if (!target || !existsSync(target)) return Promise.resolve({ stdout: '', stderr: '' });
    if (args[0] === '--encrypt') {
      writeFileSync(target, fakeEncrypt(readFileSync(target, 'utf8')), 'utf8');
    } else if (args[0] === '--decrypt') {
      writeFileSync(target, fakeDecrypt(readFileSync(target, 'utf8')), 'utf8');
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  }
}

describe('sops sink', () => {
  const SAVED_KEYS = ['ENVSEAL_SOPS_AGE_RECIPIENT', 'PATH'] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const name of SAVED_KEYS) savedEnv[name] = process.env[name];
  });

  afterEach(() => {
    delete process.env.ENVSEAL_SOPS_AGE_RECIPIENT;
    for (const name of SAVED_KEYS) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('scripted harness (all platforms)', () => {
    let sink: ScriptedSopsSink;
    let paths: ProjectPaths;

    beforeEach(() => {
      sink = new ScriptedSopsSink();
      paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-sp-')));
      process.env.ENVSEAL_SOPS_AGE_RECIPIENT = 'age1testrecipientxxxxxxxxxxxxxxxxxxx';
    });

    afterEach(() => {
      rmSync(paths.root, { recursive: true, force: true });
    });

    it('available() demands a config file or an age recipient on top of the CLI probe', async () => {
      expect(await sink.available(paths)).toBe(true);
      delete process.env.ENVSEAL_SOPS_AGE_RECIPIENT;
      expect(await sink.available(paths)).toBe(false);
    });

    it('write stores ciphertext at the sidecar and read round-trips byte-exact', async () => {
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      const sidecar = join(paths.root, '.env.sealsops.yaml');
      expect(existsSync(sidecar)).toBe(true);
      const raw = readFileSync(sidecar, 'utf8');
      expect(raw).toContain('ENCFAKE[');
      expect(raw).not.toContain(VALUE);

      const read = await sink.read(paths, 'API_KEY');
      expect(read?.toString('utf8')).toBe(VALUE);
    });

    it('the secret value never appears on any sops argv', async () => {
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      await sink.read(paths, 'API_KEY');
      await sink.remove(paths, 'API_KEY');
      for (const call of sink.calls) {
        for (const arg of call) expect(arg).not.toContain(VALUE);
      }
      // And the invocations carry only paths/flags: encrypt and decrypt each
      // name their input type, output type, and exactly one file argument.
      expect(sink.calls[0]?.slice(0, 6)).toEqual([
        '--encrypt',
        '--input-type',
        'yaml',
        '--output-type',
        'yaml',
        '--age',
      ]);
    });

    it('read on a missing sidecar returns null without spawning anything', async () => {
      const read = await sink.read(paths, 'NEVER_STORED');
      expect(read).toBeNull();
      expect(sink.calls).toHaveLength(0);
    });

    it('read returns null for a key the store does not hold', async () => {
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      expect(await sink.read(paths, 'OTHER_KEY')).toBeNull();
    });

    it('a second write preserves the first key (merge, not replace)', async () => {
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      await sink.write(paths, 'DB_PASSWORD', asSecret(Buffer.from('postgres://u:p@h/db', 'utf8')));
      expect((await sink.read(paths, 'API_KEY'))?.toString('utf8')).toBe(VALUE);
      expect((await sink.read(paths, 'DB_PASSWORD'))?.toString('utf8')).toBe('postgres://u:p@h/db');
    });

    it('remove deletes one key, keeps the other, and reports absence as false', async () => {
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      await sink.write(paths, 'DB_PASSWORD', asSecret(Buffer.from('x', 'utf8')));
      expect(await sink.remove(paths, 'API_KEY')).toBe(true);
      expect(await sink.read(paths, 'API_KEY')).toBeNull();
      expect((await sink.read(paths, 'DB_PASSWORD'))?.toString('utf8')).toBe('x');
      expect(await sink.remove(paths, 'NEVER_STORED')).toBe(false);
    });

    it('removing the last key deletes the sidecar entirely', async () => {
      await sink.write(paths, 'ONLY_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      const sidecar = join(paths.root, '.env.sealsops.yaml');
      expect(existsSync(sidecar)).toBe(true);
      expect(await sink.remove(paths, 'ONLY_KEY')).toBe(true);
      expect(existsSync(sidecar)).toBe(false);
    });

    it('write refuses with SEP_GITIGNORE_UNSAFE when the sidecar is unignored in a repo', async () => {
      execSync('git init -q', { cwd: paths.root });
      execSync('git -C "' + paths.root + '" config user.email t@t', { stdio: 'ignore' });
      execSync('git -C "' + paths.root + '" config user.name t', { stdio: 'ignore' });
      // No .gitignore entry covers .env.sealsops.yaml.
      const error = await sepFrom(sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8'))));
      expect(error.code).toBe('SEP_GITIGNORE_UNSAFE');
      const sidecar = join(paths.root, '.env.sealsops.yaml');
      expect(existsSync(sidecar)).toBe(false);
    });

    it('write succeeds once .gitignore covers the sidecar', async () => {
      execSync('git init -q', { cwd: paths.root });
      execSync(`git -C "${paths.root}" add -A`, { stdio: 'ignore' });
      writeFileSync(join(paths.root, '.gitignore'), '.env*\n*.sealsops.yaml\n', 'utf8');
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      expect(existsSync(join(paths.root, '.env.sealsops.yaml'))).toBe(true);
    });

    it('.sops.yaml creation rules take precedence over the age-recipient branch', async () => {
      delete process.env.ENVSEAL_SOPS_AGE_RECIPIENT;
      writeFileSync(
        join(paths.root, '.sops.yaml'),
        'creation_rules:\n  - path_regex: .*\\n    age: age1test\n',
        'utf8',
      );
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      const encryptCall = sink.calls.find((c) => c[0] === '--encrypt');
      expect(encryptCall).toBeDefined();
      expect(encryptCall).not.toContain('--age');
      expect((await sink.read(paths, 'API_KEY'))?.toString('utf8')).toBe(VALUE);
    });

    it('operations refuse with SEP_SINK_UNAVAILABLE when neither config nor recipient exists', async () => {
      delete process.env.ENVSEAL_SOPS_AGE_RECIPIENT;
      const error = await sepFrom(sink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('ENVSEAL_SOPS_AGE_RECIPIENT');
      await expect(sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')))).rejects.toThrow(
        /ENVSEAL_SOPS_AGE_RECIPIENT/,
      );
    });

    it('a decrypt failure is a loud SEP_SINK_WRITE_FAILED, never a silent null', async () => {
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      sink.respond = async () => {
        throw new CliCommandFailure(
          'sops exited with code 128: no matching private key found',
          'sops',
          128,
          'no matching private key found',
        );
      };
      const error = await sepFrom(sink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_WRITE_FAILED');
      expect(error.details).toMatchObject({ sink: 'sops', operation: 'read', exitCode: 128 });
    });

    it('staging directories are cleaned up after every operation', async () => {
      await sink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      await sink.remove(paths, 'API_KEY');
      const stateDir = join(paths.root, '.envseal');
      if (existsSync(stateDir)) {
        const names = readdirSync(stateDir) as string[];
        expect(names.filter((n) => n.startsWith('sops-'))).toEqual([]);
      }
    });
  });

  // Exercises the unmodified sink through the real exec pipeline against a
  // staged fake binary — POSIX-only because Windows cannot spawn shebangs.
  describe.skipIf(process.platform === 'win32')('fake sops CLI on PATH (POSIX)', () => {
    let binDir: string;
    let paths: ProjectPaths;

    beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), 'envseal-sopsfake-'));
      paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-sp-')));
      const fake = [
        '#!/bin/sh',
        '# Fake sops for sops-sink.test.ts: transforms the target file in place.',
        '# Last argument via the portable idiom: bash\'s ${!#} indirection is a',
        '# bashism that dash silently expands to "" (proved by CI: python got',
        '# \'\' as its path and died with FileNotFoundError on ubuntu, while the',
        '# macOS leg — bash-as-sh — passed).',
        'for target in "$@"; do :; done',
        'case "$1" in',
        '  --encrypt) python3 - "$target" <<\'PY\'',
        'import sys,base64',
        'p=sys.argv[1]',
        't=open(p).read()',
        'open(p,"w").write("\\n".join("ENCFAKE["+base64.b64encode(l.encode()).decode()+"]" if l.strip() and ":" in l else l for l in t.split("\\n")))',
        'PY',
        '    ;;',
        '  --decrypt) python3 - "$target" <<\'PY\'',
        'import sys,base64,re',
        'p=sys.argv[1]',
        't=open(p).read()',
        'open(p,"w").write(re.sub(r"^ENCFAKE\\[(.*)\\]$", lambda m: base64.b64decode(m.group(1)).decode(), t, flags=re.M))',
        'PY',
        '    ;;',
        '  *)',
        '    echo "fake sops: unexpected invocation: $*" >&2',
        '    exit 64',
        '    ;;',
        'esac',
      ].join('\n');
      writeFileSync(join(binDir, 'sops'), fake, { mode: 0o755 });
      chmodSync(join(binDir, 'sops'), 0o755);
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
      process.env.ENVSEAL_SOPS_AGE_RECIPIENT = 'age1testrecipientxxxxxxxxxxxxxxxxxxx';
    });

    afterEach(() => {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(paths.root, { recursive: true, force: true });
    });

    it('available() sees the staged CLI plus recipient', async () => {
      expect(await sopsSink.available(paths)).toBe(true);
    });

    it('write then read round-trips through the real spawn pipeline', async () => {
      await sopsSink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8')));
      const raw = readFileSync(join(paths.root, '.env.sealsops.yaml'), 'utf8');
      expect(raw).toContain('ENCFAKE[');
      expect(raw).not.toContain(VALUE);
      expect((await sopsSink.read(paths, 'API_KEY'))?.toString('utf8')).toBe(VALUE);
    });
  });

  // Real assertions on THIS machine, where sops is genuinely absent: if the
  // sink ever stops degrading to false/refusals, these fail.
  describe.skipIf(sopsInstalled)('sops CLI missing (this machine)', () => {
    let paths: ProjectPaths;

    beforeEach(() => {
      paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-sp-')));
      process.env.ENVSEAL_SOPS_AGE_RECIPIENT = 'age1testrecipientxxxxxxxxxxxxxxxxxxx';
    });

    afterEach(() => {
      rmSync(paths.root, { recursive: true, force: true });
    });

    it('available() is false even with a recipient configured', async () => {
      expect(await sopsSink.available(paths)).toBe(false);
    });

    it('read refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
      const error = await sepFrom(sopsSink.read(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('sops CLI is not installed');
    });

    it('write refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
      const error = await sepFrom(
        sopsSink.write(paths, 'API_KEY', asSecret(Buffer.from(VALUE, 'utf8'))),
      );
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('sops CLI is not installed');
    });

    it('remove refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
      const error = await sepFrom(sopsSink.remove(paths, 'API_KEY'));
      expect(error.code).toBe('SEP_SINK_UNAVAILABLE');
      expect(error.message).toContain('sops CLI is not installed');
    });
  });
});
