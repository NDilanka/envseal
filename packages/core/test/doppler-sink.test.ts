import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { asSecret, SepError } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import { CliCommandFailure, commandExists, execCli } from '../src/sinks/cli-sink-base.js';
import type { CliExecOptions, CliExecResult } from '../src/sinks/cli-sink-base.js';
import { DopplerSink, dopplerCredentialConfigured, dopplerSink } from '../src/sinks/doppler.js';

/**
 * A fake that stands in for the doppler binary at the sink's run() choke
 * point. This is the only way to exercise the parsing/error-mapping logic on
 * every machine: Windows cannot spawn shebang scripts and modern Node refuses
 * .cmd shims outright (CVE-2024-27980), so a PATH-staged double would leave
 * this whole suite unrunnable there (same trade as vault.ts). The real
 * commandExists/execCli plumbing gets its own POSIX-only staged-PATH suite
 * below, and a real CLI its gated round-trip.
 */
interface FakeCall {
  args: string[];
  stdin: string;
}

interface FakeReply {
  code: number;
  stdout?: string;
  stderr?: string;

  /** Simulate the child never spawning (binary vanished mid-flight). */
  enoent?: boolean;
}

class FakeDopplerSink extends DopplerSink {
  readonly calls: FakeCall[] = [];
  reply: (args: string[], stdin: string) => FakeReply = () => ({ code: 0 });

  protected override async requirePrerequisites(): Promise<void> {
    // The fake stands in for the binary, so the base probe — which would fail
    // wherever doppler is genuinely absent — is bypassed here and exercised
    // for real by the no-CLI suite at the bottom of this file.
  }

  protected override run(
    args: readonly string[],
    options: CliExecOptions = {},
  ): Promise<CliExecResult> {
    const stdin = options.input ?? '';
    this.calls.push({ args: [...args], stdin });
    const reply = this.reply(args, stdin);
    if (reply.enoent) {
      return Promise.reject(Object.assign(new Error('spawn doppler ENOENT'), { code: 'ENOENT' }));
    }
    if (reply.code === 0) {
      return Promise.resolve({ stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' });
    }
    const stderr = reply.stderr ?? '';
    return Promise.reject(
      new CliCommandFailure(
        `doppler exited with code ${reply.code}: ${stderr}`,
        'doppler',
        reply.code,
        stderr,
      ),
    );
  }
}

function expectSepError(err: unknown): SepError {
  expect(err instanceof SepError).toBe(true);
  return err as SepError;
}

describe('doppler sink (fake provider)', () => {
  let tmpDir: string;
  let savedToken: string | undefined;
  let savedProject: string | undefined;
  let savedConfig: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-doppler-'));
    savedToken = process.env.DOPPLER_TOKEN;
    savedProject = process.env.ENVSEAL_DOPPLER_PROJECT;
    savedConfig = process.env.ENVSEAL_DOPPLER_CONFIG;
    // The credential gate runs for real inside every operation; the token is
    // what satisfies it portably (a developer machine with a prior
    // `doppler configure` must not change these results).
    process.env.DOPPLER_TOKEN = 'test-token';
    delete process.env.ENVSEAL_DOPPLER_PROJECT;
    delete process.env.ENVSEAL_DOPPLER_CONFIG;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.DOPPLER_TOKEN;
    else process.env.DOPPLER_TOKEN = savedToken;
    if (savedProject === undefined) delete process.env.ENVSEAL_DOPPLER_PROJECT;
    else process.env.ENVSEAL_DOPPLER_PROJECT = savedProject;
    if (savedConfig === undefined) delete process.env.ENVSEAL_DOPPLER_CONFIG;
    else process.env.ENVSEAL_DOPPLER_CONFIG = savedConfig;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('scoping', () => {
    it('defaults to the sanitized project directory name and config dev', async () => {
      const sink = new FakeDopplerSink();
      const paths = projectPaths(join(tmpDir, 'My App!'));
      await sink.write(paths, 'KEY', asSecret(Buffer.from('v', 'utf8')));
      expect(sink.calls[0]?.args).toEqual([
        'secrets',
        'set',
        'KEY',
        '--project',
        'my-app',
        '--config',
        'dev',
      ]);
    });

    it('maps characters outside the doppler name alphabet onto dashes', async () => {
      const sink = new FakeDopplerSink();
      const paths = projectPaths(join(tmpDir, 'my.app'));
      await sink.write(paths, 'KEY', asSecret(Buffer.from('v', 'utf8')));
      expect(sink.calls[0]?.args).toContain('my-app');
    });

    it('falls back when sanitizing leaves nothing', async () => {
      const sink = new FakeDopplerSink();
      const paths = projectPaths(join(tmpDir, '---'));
      await sink.write(paths, 'KEY', asSecret(Buffer.from('v', 'utf8')));
      expect(sink.calls[0]?.args).toContain('envseal-project');
    });

    it('caps the derived name at 60 characters without a trailing dash', async () => {
      const sink = new FakeDopplerSink();
      const paths = projectPaths(join(tmpDir, `${'x'.repeat(70)}-`));
      await sink.write(paths, 'KEY', asSecret(Buffer.from('v', 'utf8')));
      const project = sink.calls[0]?.args[4];
      expect(project?.length).toBe(60);
      expect(project?.endsWith('-')).toBe(false);
    });

    it('ENVSEAL_DOPPLER_PROJECT/CONFIG overrides pass through verbatim', async () => {
      process.env.ENVSEAL_DOPPLER_PROJECT = 'Custom_Proj';
      process.env.ENVSEAL_DOPPLER_CONFIG = 'prod';
      const sink = new FakeDopplerSink();
      const paths = projectPaths(join(tmpDir, 'whatever'));
      await sink.write(paths, 'KEY', asSecret(Buffer.from('v', 'utf8')));
      expect(sink.calls[0]?.args).toEqual([
        'secrets',
        'set',
        'KEY',
        '--project',
        'Custom_Proj',
        '--config',
        'prod',
      ]);
    });
  });

  describe('write transport', () => {
    it('passes the value through stdin, never argv', async () => {
      const sink = new FakeDopplerSink();
      const value = 'one two three; $pecial';
      await sink.write(projectPaths(tmpDir), 'API_KEY', asSecret(Buffer.from(value, 'utf8')));
      const call = sink.calls[0];
      expect(call?.stdin).toBe(value);
      expect(JSON.stringify(call?.args)).not.toContain('one two');
    });

    it('round-trips values containing spaces and newlines through the store', async () => {
      const sink = new FakeDopplerSink();
      const store = new Map<string, string>();
      sink.reply = (args, stdin) => {
        if (args[0] === 'secrets' && args[1] === 'set') {
          const key = args[2];
          if (key !== undefined) store.set(key, stdin);
          return { code: 0 };
        }
        if (args[0] === 'secrets' && args[1] === 'get') {
          const key = args[2];
          const found = key !== undefined ? store.get(key) : undefined;
          if (found === undefined) {
            return { code: 1, stderr: `Doppler Error: Could not find requested secret: ${key ?? ''}` };
          }
          return { code: 0, stdout: `${found}\n` };
        }
        return { code: 0 };
      };
      const paths = projectPaths(tmpDir);
      const value = 'p@ss word\nline two\nwith=equals';
      await sink.write(paths, 'MULTILINE', asSecret(Buffer.from(value, 'utf8')));
      const read = await sink.read(paths, 'MULTILINE');
      expect(read?.toString('utf8')).toBe(value);
    });
  });

  describe('read', () => {
    it('sends the documented argv shape and strips exactly one trailing newline', async () => {
      const sink = new FakeDopplerSink();
      const paths = projectPaths(join(tmpDir, 'scoped-proj'));
      sink.reply = () => ({ code: 0, stdout: 'plain-value\n' });
      const read = await sink.read(paths, 'KEY');
      expect(read?.toString('utf8')).toBe('plain-value');
      expect(sink.calls[0]?.args).toEqual([
        'secrets',
        'get',
        'KEY',
        '--plain',
        '--project',
        'scoped-proj',
        '--config',
        'dev',
      ]);
    });

    it('reports exit-0 empty output as null', async () => {
      const sink = new FakeDopplerSink();
      sink.reply = () => ({ code: 0, stdout: '' });
      expect(await sink.read(projectPaths(tmpDir), 'KEY')).toBeNull();
    });

    it('reports the missing-secret error as null', async () => {
      const sink = new FakeDopplerSink();
      // Wording pinned from DopplerHQ/cli pkg/cmd/secrets.go — this suite once
      // faked a "not found" message doppler has never emitted, and the real
      // mapping never fired against a live CLI.
      sink.reply = () => ({ code: 1, stderr: 'Doppler Error: Could not find requested secret: KEY' });
      expect(await sink.read(projectPaths(tmpDir), 'KEY')).toBeNull();
    });

    it('keeps scope misses loud — "not found" wording alone is not absence', async () => {
      // A project/config miss carries its own "not found"; treating it as an
      // absent secret would send ensure() back to the prompt on every run for
      // a mistyped ENVSEAL_DOPPLER_PROJECT instead of failing loudly.
      const sink = new FakeDopplerSink();
      sink.reply = () => ({ code: 1, stderr: 'project "nope" not found in workspace w' });
      const err = expectSepError(await sink.read(projectPaths(tmpDir), 'KEY').catch((e) => e));
      expect(err.code).toBe('SEP_SINK_WRITE_FAILED');
    });

    it('keeps other failures loud as SEP_SINK_WRITE_FAILED with provider stderr in details', async () => {
      const sink = new FakeDopplerSink();
      sink.reply = () => ({ code: 1, stderr: 'Doppler API error 401: invalid token' });
      const err = expectSepError(await sink.read(projectPaths(tmpDir), 'KEY').catch((e) => e));
      expect(err.code).toBe('SEP_SINK_WRITE_FAILED');
      expect(err.userMessage).toContain('read KEY via doppler');
      const details = err.details as { stderr?: string; operation?: string };
      expect(details.operation).toBe('read');
      expect(details.stderr).toContain('invalid token');
    });

    it('maps a vanished binary (ENOENT) onto SEP_SINK_UNAVAILABLE', async () => {
      const sink = new FakeDopplerSink();
      sink.reply = () => ({ code: 0, enoent: true });
      const err = expectSepError(await sink.read(projectPaths(tmpDir), 'KEY').catch((e) => e));
      expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
    });
  });

  describe('remove', () => {
    it('returns true on success and false on "not found"', async () => {
      const sink = new FakeDopplerSink();
      sink.reply = () => ({ code: 0 });
      expect(await sink.remove(projectPaths(tmpDir), 'KEY')).toBe(true);
      expect(sink.calls[0]?.args).toEqual([
        'secrets',
        'delete',
        'KEY',
        '--yes',
        '--project',
        expect.any(String),
        '--config',
        'dev',
      ]);

      sink.reply = () => ({ code: 1, stderr: 'Doppler Error: Could not find requested secret: KEY' });
      expect(await sink.remove(projectPaths(tmpDir), 'KEY')).toBe(false);

      sink.reply = () => ({ code: 1, stderr: 'read-only service tokens cannot delete' });
      const err = expectSepError(await sink.remove(projectPaths(tmpDir), 'KEY').catch((e) => e));
      expect(err.code).toBe('SEP_SINK_WRITE_FAILED');
    });
  });

  describe('credential gate', () => {
    it('operations refuse with SEP_SINK_UNAVAILABLE naming the credential prerequisite', async () => {
      // Isolate home too: os.homedir() honors HOME/USERPROFILE, so the
      // ~/.doppler/.doppler.json branch cannot see a real developer machine's
      // config from behind this assertion.
      const savedHome = process.env.HOME;
      const savedProfile = process.env.USERPROFILE;
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
      try {
        delete process.env.DOPPLER_TOKEN;
        expect(dopplerCredentialConfigured()).toBe(false);
        const sink = new FakeDopplerSink();
        const err = expectSepError(
          await sink
            .write(projectPaths(tmpDir), 'KEY', asSecret(Buffer.from('v', 'utf8')))
            .catch((e) => e),
        );
        expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
        expect(err.userMessage).toContain('no Doppler credential is configured');
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = savedProfile;
      }
    });

    it('a set DOPPLER_TOKEN satisfies the gate without any config file check', () => {
      process.env.DOPPLER_TOKEN = 'dp.pt.test';
      expect(dopplerCredentialConfigured()).toBe(true);
    });
  });
});

describe('doppler sink (staged fake CLI on PATH)', () => {
  // A real `node` script behind a shell shim exercises the genuine
  // commandExists/execCli plumbing end-to-end — but only where a shebang shim
  // is spawnable, hence the win32 skips below (see the fake-provider note).
  let stageDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'envseal-doppler-stage-'));
    writeFileSync(
      join(stageDir, 'doppler.mjs'),
      [
        'const args = process.argv.slice(2);',
        "const has = (f) => args.includes(f);",
        "if (!has('--project') || !has('--config')) { console.error('missing scope flags'); process.exit(3); }",
        "if (args[0] === 'secrets' && args[1] === 'get') {",
        "  if (!has('--plain')) { console.error('missing --plain'); process.exit(3); }",
        "  process.stdout.write('staged-plain-value\\n');",
        "  process.exit(0);",
        "} else if (args[0] === 'secrets' && args[1] === 'set') {",
        "  let data = '';",
        "  process.stdin.setEncoding('utf8');",
        "  process.stdin.on('data', (c) => { data += c; });",
        "  process.stdin.on('end', () => {",
        "    if (data !== 'staged-stdin-value') { console.error('stdin mismatch'); process.exit(4); }",
        "    process.exit(0);",
        "  });",
        "} else if (args[0] === 'secrets' && args[1] === 'delete') {",
        "  process.exit(0);",
        '} else {',
        "  process.exit(3);",
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(stageDir, 'doppler'),
      `#!/bin/sh\nexec node "${join(stageDir, 'doppler.mjs')}" "$@"\n`,
      { mode: 0o755 },
    );
    savedPath = process.env.PATH;
    process.env.PATH = `${stageDir}${delimiter}${process.env.PATH ?? ''}`;
    process.env.DOPPLER_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    else delete process.env.PATH;
    delete process.env.DOPPLER_TOKEN;
    rmSync(stageDir, { recursive: true, force: true });
  });

  function scratchPaths(): ReturnType<typeof projectPaths> {
    const paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-doppler-proj-')));
    return paths;
  }

  it.skipIf(process.platform === 'win32')('available() sees the staged binary and token', async () => {
    const paths = scratchPaths();
    try {
      expect(await dopplerSink.available(paths)).toBe(true);
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('a present binary without a credential keeps available() false', async () => {
    // HOME isolation so a developer machine's real ~/.doppler/.doppler.json
    // cannot satisfy the credential gate behind this assertion.
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    delete process.env.DOPPLER_TOKEN;
    process.env.HOME = stageDir;
    process.env.USERPROFILE = stageDir;
    const paths = scratchPaths();
    try {
      expect(dopplerCredentialConfigured()).toBe(false);
      expect(await dopplerSink.available(paths)).toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('read() parses stdout through the real execCli pipe', async () => {
    const paths = scratchPaths();
    try {
      const read = await dopplerSink.read(paths, 'STAGED_KEY');
      expect(read?.toString('utf8')).toBe('staged-plain-value');
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('write() delivers the value on stdin through the real pipe', async () => {
    const paths = scratchPaths();
    try {
      // The staged CLI exits 4 unless stdin carries exactly this byte string,
      // so a quiet pass here IS the transport assertion.
      await dopplerSink.write(paths, 'STAGED_KEY', asSecret(Buffer.from('staged-stdin-value', 'utf8')));
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });
});

const realDopplerPresent = await commandExists('doppler');

describe.skipIf(realDopplerPresent)('doppler CLI not installed on this machine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-doppler-absent-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('available() is false', async () => {
    expect(await dopplerSink.available(projectPaths(tmpDir))).toBe(false);
  });

  it('write throws SEP_SINK_UNAVAILABLE naming the missing prerequisite', async () => {
    const err = expectSepError(
      await dopplerSink
        .write(projectPaths(tmpDir), 'KEY', asSecret(Buffer.from('v', 'utf8')))
        .catch((e) => e),
    );
    expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
    expect(err.userMessage).toMatch(/doppler CLI is not installed/);
  });

  it('read throws SEP_SINK_UNAVAILABLE naming the missing prerequisite', async () => {
    const err = expectSepError(await dopplerSink.read(projectPaths(tmpDir), 'KEY').catch((e) => e));
    expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
    expect(err.userMessage).toMatch(/doppler CLI is not installed/);
  });

  it('remove throws SEP_SINK_UNAVAILABLE naming the missing prerequisite', async () => {
    const err = expectSepError(await dopplerSink.remove(projectPaths(tmpDir), 'KEY').catch((e) => e));
    expect(err.code).toBe('SEP_SINK_UNAVAILABLE');
    expect(err.userMessage).toMatch(/doppler CLI is not installed/);
  });
});

describe.skipIf(!realDopplerPresent || !dopplerCredentialConfigured())('real doppler round-trip', () => {
  let tmpDir: string;
  let projectName: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-doppler-real-'));
    projectName = `envseal-test-${randomBytes(4).toString('hex')}`;
    // Throwaway scope: created here, deleted whole in afterAll, so nothing
    // this suite writes outlives it.
    await execCli('doppler', ['project', 'create', projectName]);
    process.env.ENVSEAL_DOPPLER_PROJECT = projectName;
  }, 30_000);

  afterAll(async () => {
    delete process.env.ENVSEAL_DOPPLER_PROJECT;
    try {
      await execCli('doppler', ['project', 'delete', projectName, '--yes']);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('writes, reads, and removes against the throwaway project', async () => {
    const paths = projectPaths(tmpDir);
    const value = `rt-${randomBytes(8).toString('hex')}`;

    await dopplerSink.write(paths, 'ROUND_TRIP_KEY', asSecret(Buffer.from(value, 'utf8')));

    const read = await dopplerSink.read(paths, 'ROUND_TRIP_KEY');
    expect(read?.toString('utf8')).toBe(value);

    expect(await dopplerSink.remove(paths, 'ROUND_TRIP_KEY')).toBe(true);
    expect(await dopplerSink.read(paths, 'ROUND_TRIP_KEY')).toBeNull();
    // No assertion on a second remove(): delete maps to SetSecrets(key -> nil)
    // server-side, so whether re-deleting succeeds idempotently or errors with
    // the missing-secret wording is server-version-dependent — asserting
    // either would make this suite flaky, the same call vault.ts makes.
  }, 60_000);

  it('reads an absent key as null in a live scope', async () => {
    expect(await dopplerSink.read(projectPaths(tmpDir), 'NEVER_WRITTEN_KEY')).toBeNull();
  }, 60_000);
});
