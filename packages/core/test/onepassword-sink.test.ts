import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { asSecret, SepError } from '@envseal/protocol';
import { projectPaths } from '../src/paths.js';
import { OnePasswordSink, onepasswordSink } from '../src/sinks/onepassword.js';

// Unique per run so concurrent suites never fight over the same item title.
const KEY = `ENVSEAL_TEST_OP_${randomBytes(6).toString('hex').toUpperCase()}`;
// ASCII with punctuation: everything the stdin/stdout pipes must carry byte-exact.
const VALUE = 'sk-test-Op7#pQz!9Rd-_2Wx/4Yv+6Zt=8Nb';
// Field labels, duplicated from the sink for white-box state assertions below.
const CREDENTIAL_FIELD_LABEL = 'credential';
const KEY_FIELD_LABEL = 'envseal-key';

interface FakeState {
  vaults: string[];
  items: Array<{ title: string; vault: string; fields: Record<string, string> }>;
}

// Every fake-CLI operation boots a full node child, and the whole suite runs
// in parallel — under that load a single spawn can take seconds. The 5s
// default has no headroom; give every test here room to breathe.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Probed once at module scope, before any test puts a fake `op` on PATH: the
 * real CLI decides which of the two real-CLI blocks below can run. Both are
 * real behavior — on a machine without op, refusing loudly IS the contract.
 */
const realOpUsable = await onepasswordSink.available(projectPaths(tmpdir()));

describe.skipIf(realOpUsable)('on a machine without a usable op CLI', () => {
  let tmpDir: string;
  let paths: ReturnType<typeof projectPaths>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-op-absent-'));
    paths = projectPaths(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('degrades available() to false instead of throwing', async () => {
    await expect(onepasswordSink.available(paths)).resolves.toBe(false);
  });

  it('write refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
    await expect(
      onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8'))),
    ).rejects.toMatchObject({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: expect.stringMatching(/OP_SERVICE_ACCOUNT_TOKEN/),
    });
  });

  it('read refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
    await expect(onepasswordSink.read(paths, KEY)).rejects.toMatchObject({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: expect.stringMatching(/OP_SERVICE_ACCOUNT_TOKEN/),
    });
  });

  it('remove refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
    await expect(onepasswordSink.remove(paths, KEY)).rejects.toMatchObject({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: expect.stringMatching(/OP_SERVICE_ACCOUNT_TOKEN/),
    });
  });
});

describe.skipIf(!realOpUsable)('real op CLI round-trip', () => {
  // The dedicated 'envseal' vault persists on the account (op offers no vault
  // deletion); the per-key items below are cleaned up after each test.
  let tmpDir: string;
  let paths: ReturnType<typeof projectPaths>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-op-'));
    paths = projectPaths(tmpDir);
  });

  afterEach(async () => {
    // Best-effort cleanup; remove() is a no-op (false) when already gone.
    try {
      await onepasswordSink.remove(paths, KEY);
    } catch {
      // ignore — cleanup must never mask a test failure
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('write then read round-trips the value', async () => {
    await onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
    const read = await onepasswordSink.read(paths, KEY);
    expect(read).not.toBeNull();
    expect(read?.toString('utf8')).toBe(VALUE);
  });

  it('read on an absent key returns null', async () => {
    expect(await onepasswordSink.read(paths, KEY)).toBeNull();
  });

  it('remove deletes the item, then read returns null and remove reports false', async () => {
    await onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')));
    expect(await onepasswordSink.remove(paths, KEY)).toBe(true);
    expect(await onepasswordSink.read(paths, KEY)).toBeNull();
    expect(await onepasswordSink.remove(paths, KEY)).toBe(false);
  });
});

/**
 * A fake `op` on PATH, so the parsing, absence detection, and error mapping
 * are exercised on every machine whether or not the real CLI exists. The
 * emulator implements just enough of the v2 surface (whoami, vault
 * get/create, item get/create/delete) over a JSON state file, and steers
 * failure modes through the ENVSEAL_OP_FAKE scenario variable.
 */
describe('fake op CLI on PATH', () => {
  const isWin = process.platform === 'win32';
  // NODE_OPTIONS cannot carry quoted arguments, so every path the Windows
  // launcher needs must be space-free — and the default temp dir often is not
  // ("C:\Users\A S U S\AppData\Local\Temp"). Fall back to a scratch dir beside
  // this test file, which lives inside the repo.
  const fakeBase = tmpdir().includes(' ')
    ? dirname(fileURLToPath(import.meta.url))
    : tmpdir();

  let fakeDir = '';
  let savedPath = '';
  let savedNodeOptions: string | undefined;
  let statePath = '';
  let argvPath = '';
  let countPath = '';
  let paths: ReturnType<typeof projectPaths>;

  function readState(): FakeState {
    return JSON.parse(readFileSync(statePath, 'utf8')) as FakeState;
  }

  /** How many times the fake CLI ran for this test's count file so far. */
  function invocationCount(): number {
    return readFileSync(countPath, 'utf8')
      .split('\n')
      .filter(Boolean).length;
  }

  /** Swap in a pristine store: vault absent, no items. */
  function newState(): void {
    statePath = join(fakeDir, `state-${randomBytes(6).toString('hex')}.json`);
    writeFileSync(statePath, JSON.stringify({ vaults: [], items: [] }));
    process.env.ENVSEAL_OP_FAKE_STATE = statePath;
  }

  /** Fresh per-test argv-dump and invocation-count targets. */
  function freshTraces(): void {
    argvPath = join(fakeDir, `argv-${randomBytes(6).toString('hex')}.json`);
    countPath = join(fakeDir, `count-${randomBytes(6).toString('hex')}.txt`);
    process.env.ENVSEAL_OP_FAKE_ARGV = argvPath;
    process.env.ENVSEAL_OP_FAKE_COUNT = countPath;
  }

  /**
   * One retry for NTSTATUS-scale exit codes (0xC0000000 and up). Those are
   * Windows failing to LAUNCH the op.exe node-copy under full-suite memory
   * pressure — neither the real op nor the emulator ever emits them, and no
   * scenario here asserts on one, so the retry can never mask a mapped
   * failure. A second consecutive crash still fails loudly.
   */
  async function withLaunchRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      const details = (error as { details?: { exitCode?: number | null } }).details;
      if ((details?.exitCode ?? 0) < 1_000_000) throw error;
      return op();
    }
  }

  beforeAll(() => {
    fakeDir = mkdtempSync(join(fakeBase, 'envseal-opfake-'));
    const emulator = join(fakeDir, 'emulator.cjs');
    writeFileSync(emulator, EMULATOR_SOURCE);
    savedPath = process.env.PATH ?? '';
    savedNodeOptions = process.env.NODE_OPTIONS;
    if (isWin) {
      // CreateProcess (behind spawn with shell:false) executes .exe files
      // only, so a shell script cannot fake the CLI here. A copied node
      // binary poses as op.exe; the launcher rides in through
      // NODE_OPTIONS=--require and redirects the phantom entry point to the
      // emulator (see WIN_LAUNCHER_SOURCE).
      const launcher = join(fakeDir, 'op-launcher.cjs');
      writeFileSync(launcher, WIN_LAUNCHER_SOURCE);
      const phantom = join(fakeDir, 'phantom-main.cjs');
      writeFileSync(phantom, WIN_PHANTOM_SOURCE);
      process.env.ENVSEAL_OP_FAKE_EMULATOR = emulator;
      process.env.ENVSEAL_OP_FAKE_MAIN = phantom;
      copyFileSync(process.execPath, join(fakeDir, 'op.exe'));
    } else {
      const shim = join(fakeDir, 'op');
      writeFileSync(
        shim,
        `#!/bin/sh\nexec '${process.execPath}' '${emulator}' "$@"\n`,
      );
      chmodSync(shim, 0o755);
    }
  });

  beforeEach(() => {
    paths = projectPaths(mkdtempSync(join(tmpdir(), 'envseal-opproj-')));
    // The happy-path tests share one store: every key in play is unique per
    // run and per test, so item-level independence holds without paying for a
    // fresh vault on every write. Tests that genuinely need a pristine store
    // call newState() first.
    statePath = join(fakeDir, 'state-ok.json');
    if (!existsSync(statePath)) {
      writeFileSync(statePath, JSON.stringify({ vaults: [], items: [] }));
    }
    process.env.ENVSEAL_OP_FAKE = 'ok';
    process.env.ENVSEAL_OP_FAKE_STATE = statePath;
    freshTraces();
    process.env.PATH = fakeDir + delimiter + savedPath;
    if (isWin) {
      process.env.NODE_OPTIONS = `--require ${join(fakeDir, 'op-launcher.cjs')}`;
    }
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = savedNodeOptions;
    }
    delete process.env.ENVSEAL_OP_FAKE;
    delete process.env.ENVSEAL_OP_FAKE_STATE;
    delete process.env.ENVSEAL_OP_FAKE_ARGV;
    delete process.env.ENVSEAL_OP_FAKE_COUNT;
    rmSync(argvPath, { force: true });
    rmSync(countPath, { force: true });
    rmSync(paths.root, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    if (savedNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = savedNodeOptions;
    }
    delete process.env.ENVSEAL_OP_FAKE_EMULATOR;
    delete process.env.ENVSEAL_OP_FAKE_MAIN;
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('reports available when the CLI answers whoami', async () => {
    await expect(onepasswordSink.available(paths)).resolves.toBe(true);
  });

  it('probes whoami once per instance, then trusts the session for later operations', async () => {
    // A fresh instance, not the shared singleton: the memo is per-instance.
    const local = new OnePasswordSink();
    await withLaunchRetry(() => local.read(paths, KEY)); // whoami + item get
    expect(invocationCount()).toBe(2);
    await withLaunchRetry(() => local.read(paths, KEY)); // item get only — session validated
    expect(invocationCount()).toBe(3);
  });

  it('write then read round-trips the value', async () => {
    await withLaunchRetry(() => onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8'))));
    const read = await withLaunchRetry(() => onepasswordSink.read(paths, KEY));
    expect(read?.toString('utf8')).toBe(VALUE);
  });

  it('round-trips a trailing newline byte-exactly (output padding is trimmed, not data)', async () => {
    const value = 'line-one\nline-two\n';
    await withLaunchRetry(() => onepasswordSink.write(paths, KEY, asSecret(Buffer.from(value, 'utf8'))));
    const read = await withLaunchRetry(() => onepasswordSink.read(paths, KEY));
    expect(read?.toString('utf8')).toBe(value);
  });

  it('read on an absent key returns null', async () => {
    expect(await withLaunchRetry(() => onepasswordSink.read(paths, KEY))).toBeNull();
  });

  it('remove on an absent key reports false', async () => {
    expect(await withLaunchRetry(() => onepasswordSink.remove(paths, KEY))).toBe(false);
  });

  it('remove deletes the item, then read returns null and remove reports false', async () => {
    await withLaunchRetry(() => onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8'))));
    expect(await withLaunchRetry(() => onepasswordSink.remove(paths, KEY))).toBe(true);
    expect(await withLaunchRetry(() => onepasswordSink.read(paths, KEY))).toBeNull();
    expect(await withLaunchRetry(() => onepasswordSink.remove(paths, KEY))).toBe(false);
  });

  it('the first write creates the envseal vault', async () => {
    // A pristine store, so this genuinely exercises creation rather than
    // riding on the shared store's already-created vault.
    newState();
    await withLaunchRetry(() => onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8'))));
    expect(readState().vaults).toContain('envseal');
  });

  it('rewriting a key replaces the item instead of stacking duplicates', async () => {
    await withLaunchRetry(() => onepasswordSink.write(paths, KEY, asSecret(Buffer.from('first-value', 'utf8'))));
    await withLaunchRetry(() => onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8'))));
    const items = readState().items.filter(
      (item) => item.vault === 'envseal' && item.title === `${basename(paths.root)}:${KEY}`,
    );
    expect(items).toHaveLength(1);
    const read = await withLaunchRetry(() => onepasswordSink.read(paths, KEY));
    expect(read?.toString('utf8')).toBe(VALUE);
  });

  it('files items under the project-scoped title with a key marker field', async () => {
    // Pristine store: the KEY repeats across this file's tests (unique per
    // run, not per test), so an older item could shadow the one under
    // assertion here.
    newState();
    await withLaunchRetry(() => onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8'))));
    const item = readState().items.find((entry) => entry.fields[KEY_FIELD_LABEL] === KEY);
    expect(item?.title).toBe(`${basename(paths.root)}:${KEY}`);
    expect(item?.fields[CREDENTIAL_FIELD_LABEL]).toBe(VALUE);
  });

  it('keeps the value off argv entirely', async () => {
    await withLaunchRetry(() => onepasswordSink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8'))));
    // The emulator dumps the argv of every invocation; the last one was this
    // test's item create that carried the value.
    const argv = JSON.parse(readFileSync(argvPath, 'utf8')) as string[];
    expect(argv.join(' ')).not.toContain(VALUE);
    expect(argv.join(' ')).toContain('-');
  });

  // Each scenario block uses a FRESH sink instance: the whoami memo is
  // per-instance, and a probe cached against one credential state must never
  // answer for another.
  describe('when no non-interactive credential is configured', () => {
    let sink: OnePasswordSink;

    beforeEach(() => {
      process.env.ENVSEAL_OP_FAKE = 'unauthenticated';
      newState();
      freshTraces();
      sink = new OnePasswordSink();
    });

    it('degrades available() to false', async () => {
      await expect(sink.available(paths)).resolves.toBe(false);
    });

    it('every operation refuses with SEP_SINK_UNAVAILABLE naming the prerequisite', async () => {
      const unavailable = {
        code: 'SEP_SINK_UNAVAILABLE',
        userMessage: expect.stringMatching(/OP_SERVICE_ACCOUNT_TOKEN/),
      };
      await expect(withLaunchRetry(() => sink.read(paths, KEY))).rejects.toMatchObject(unavailable);
      await expect(
        withLaunchRetry(() => sink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')))),
      ).rejects.toMatchObject(unavailable);
      await expect(withLaunchRetry(() => sink.remove(paths, KEY))).rejects.toMatchObject(unavailable);
    });
  });

  describe('when creating the item fails', () => {
    let sink: OnePasswordSink;

    beforeEach(() => {
      process.env.ENVSEAL_OP_FAKE = 'failcreate';
      newState();
      freshTraces();
      sink = new OnePasswordSink();
    });

    it('write throws SEP_SINK_WRITE_FAILED and stores nothing', async () => {
      await expect(
        withLaunchRetry(() => sink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')))),
      ).rejects.toMatchObject({ code: 'SEP_SINK_WRITE_FAILED' });
      expect(readState().items).toHaveLength(0);
    });
  });

  describe('when vault creation is not permitted', () => {
    let sink: OnePasswordSink;

    beforeEach(() => {
      process.env.ENVSEAL_OP_FAKE = 'restricted';
      newState();
      freshTraces();
      sink = new OnePasswordSink();
    });

    it('write throws SEP_SINK_WRITE_FAILED instead of pretending the vault exists', async () => {
      await expect(
        withLaunchRetry(() => sink.write(paths, KEY, asSecret(Buffer.from(VALUE, 'utf8')))),
      ).rejects.toMatchObject({ code: 'SEP_SINK_WRITE_FAILED' });
    });
  });

  describe('when reading fails for a real reason', () => {
    let sink: OnePasswordSink;

    beforeEach(() => {
      process.env.ENVSEAL_OP_FAKE = 'failread';
      newState();
      freshTraces();
      sink = new OnePasswordSink();
    });

    it('read throws a loud SepError rather than masquerading as absence', async () => {
      await expect(withLaunchRetry(() => sink.read(paths, KEY))).rejects.toThrowError(SepError);
      await expect(withLaunchRetry(() => sink.read(paths, KEY))).rejects.toMatchObject({
        code: 'SEP_SINK_WRITE_FAILED',
        userMessage: expect.stringMatching(/exit code 1/),
      });
    });
  });
});

/**
 * The fake CLI itself. Deliberately plain ES5-ish CommonJS with no
 * dependencies: it is executed by a raw node child (or a node.exe copy posing
 * as op.exe) with no bundler or transform behind it.
 */
/**
 * Loaded into the node.exe copy posing as op.exe via NODE_OPTIONS=--require.
 * Node resolves the bare verb ("whoami") to a nonexistent path under the
 * caller's cwd and would die with MODULE_NOT_FOUND before any preload could
 * take over; no preload can cancel runMain either, and blocking its thread
 * would starve stdin. So the preload instead redirects exactly that failed
 * entry-point lookup to a real script — node then runs the emulator as its
 * main module and the event loop behaves like any normal child's.
 */
const WIN_LAUNCHER_SOURCE = [
  "'use strict';",
  "var path = require('node:path');",
  "var Module = require('node:module');",
  'var resolveFilename = Module._resolveFilename;',
  'Module._resolveFilename = function (request) {',
  '  try {',
  '    return resolveFilename.apply(this, arguments);',
  '  } catch (err) {',
  "    var head = path.basename(String(request || ''));",
  "    if (head === 'whoami' || head === 'item' || head === 'vault') {",
  '      return process.env.ENVSEAL_OP_FAKE_MAIN;',
  '    }',
  '    throw err;',
  '  }',
  '};',
].join('\n');

/** The entry module the launcher redirects to: it just boots the emulator. */
const WIN_PHANTOM_SOURCE = [
  "'use strict';",
  '// Main module of the fake op.exe child (handed over by op-launcher.cjs):',
  '// running the emulator here gives its async stdin/stdout work a normal',
  '// event loop, and the process exits with whatever code the emulator sets.',
  'require(process.env.ENVSEAL_OP_FAKE_EMULATOR);',
].join('\n');

const EMULATOR_SOURCE = [
  "'use strict';",
  '// Fake `op` CLI for onepassword-sink.test.ts: just enough of the v2 surface',
  '// (whoami, vault get/create, item get/create/delete) over a JSON state file.',
  '// Behavior is steered by env vars:',
  "//   ENVSEAL_OP_FAKE_STATE  path of the JSON store",
  '//   ENVSEAL_OP_FAKE_ARGV   where the argv of each invocation is dumped',
  '//   ENVSEAL_OP_FAKE_COUNT  invocation counter, one line per run',
  '//   ENVSEAL_OP_FAKE        ok | unauthenticated | restricted | failcreate | failread',
  "var fs = require('node:fs');",
  "var path = require('node:path');",
  '',
  'function readStdin() {',
  '  return new Promise(function (resolve) {',
  "    var raw = '';",
  "    process.stdin.setEncoding('utf8');",
  "    process.stdin.on('data', function (chunk) { raw += chunk; });",
  "    process.stdin.on('end', function () { resolve(raw); });",
  '  });',
  '}',
  '',
  '// Flush stdout/stderr before tearing down: process.exit straight after a',
  '// pipe write can drop the chunk on Windows.',
  'function finish(code, out, err) {',
  '  var pending = 0;',
  '  var exit = function () { if (pending === 0) process.exit(code); };',
  '  if (out) { pending++; process.stdout.write(out, function () { pending--; exit(); }); }',
  '  if (err) { pending++; process.stderr.write(err, function () { pending--; exit(); }); }',
  '  exit();',
  '  setTimeout(exit, 1000).unref();',
  '}',
  '',
  "var PREFIX = '[ERROR] 2026-08-22 00:00:00 | ';",
  "function absentItem(title, vault) { return PREFIX + JSON.stringify(title) + ' isn\\'t an item in the ' + vault + ' vault.'; }",
  "function absentVault(vault) { return PREFIX + JSON.stringify(vault) + ' isn\\'t a vault in this account.'; }",
  '',
  'function main() {',
  '  var statePath = process.env.ENVSEAL_OP_FAKE_STATE;',
  "  var scenario = process.env.ENVSEAL_OP_FAKE || 'ok';",
  '  if (!statePath) {',
  "    finish(3, '', '[ERROR] fake op: ENVSEAL_OP_FAKE_STATE is not set');",
  '    return;',
  '  }',
  "  var known = ['whoami', 'item', 'vault'];",
  '  if (process.argv.length > 1 && known.indexOf(path.basename(String(process.argv[1]))) !== -1) {',
  "    // Under the op.exe node-copy, node resolves the bare verb to an absolute",
  "    // path under the caller's cwd before we see it; normalize it back.",
  '    process.argv[1] = path.basename(String(process.argv[1]));',
  '  }',
  '  var start = -1;',
  '  for (var i = 1; i < process.argv.length; i++) {',
  '    if (known.indexOf(process.argv[i]) !== -1) { start = i; break; }',
  '  }',
  '  try { fs.writeFileSync(process.env.ENVSEAL_OP_FAKE_ARGV, JSON.stringify(process.argv)); } catch (e) {}',
  "  try { fs.appendFileSync(process.env.ENVSEAL_OP_FAKE_COUNT, 'x\\n'); } catch (e) {}",
  '  if (start < 0) {',
  "    finish(1, '', '[ERROR] fake op: unrecognized invocation');",
  '    return;',
  '  }',
  '  var args = process.argv.slice(start);',
  '  var state = JSON.parse(fs.readFileSync(statePath, \'utf8\'));',
  '  function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }',
  '  function flag(name) {',
  '    var idx = args.indexOf(name);',
  '    return idx >= 0 ? args[idx + 1] : undefined;',
  '  }',
  '',
  '  var cmd = args[0];',
  "  if (cmd === 'whoami') {",
  "    if (scenario === 'unauthenticated') {",
  '      finish(1, \'\', PREFIX + \'no signed-in account found. Set OP_SERVICE_ACCOUNT_TOKEN or run "op account add".\');',
  '      return;',
  '    }',
  "    finish(0, 'ENVSEAL FAKE ACCOUNT (fake@envseal.invalid)\\n', '');",
  '    return;',
  '  }',
  "  if (cmd === 'vault') {",
  "    var sub = args[1];",
  '    var name = args[2];',
  "    if (sub === 'get') {",
  '      if (state.vaults.indexOf(name) >= 0) {',
  "        finish(0, '{\"id\":\"fake\",\"name\":' + JSON.stringify(name) + '}\\n', '');",
  '        return;',
  '      }',
  "      finish(1, '', absentVault(name));",
  '      return;',
  '    }',
  "    if (sub === 'create') {",
  "      if (scenario === 'restricted') {",
  "        finish(1, '', \"[ERROR] you don't have permission to create vaults in this account.\");",
  '        return;',
  '      }',
  '      if (state.vaults.indexOf(name) >= 0) {',
  "        finish(1, '', PREFIX + 'vault ' + JSON.stringify(name) + ' already exists.');",
  '        return;',
  '      }',
  '      state.vaults.push(name);',
  '      save();',
  "      finish(0, '{\"id\":\"fake\",\"name\":' + JSON.stringify(name) + '}\\n', '');",
  '      return;',
  '    }',
  "    finish(1, '', '[ERROR] fake op: unsupported vault subcommand');",
  '    return;',
  '  }',
  "  if (cmd === 'item') {",
  "    var sub2 = args[1];",
  "    if (sub2 === 'get') {",
  "      if (scenario === 'failread') {",
  "        finish(1, '', '[ERROR] could not reach the 1Password server: connection refused');",
  '        return;',
  '      }',
  '      var title = args[2];',
  '      var vault = flag(\'--vault\');',
  '      var item = null;',
  '      for (var j = 0; j < state.items.length; j++) {',
  '        if (state.items[j].title === title && state.items[j].vault === vault) { item = state.items[j]; break; }',
  '      }',
  '      if (!item) {',
  "        finish(1, '', absentItem(title, vault));",
  '        return;',
  '      }',
  '      var field = flag(\'--fields\');',
  '      if (!Object.prototype.hasOwnProperty.call(item.fields, field)) {',
  "        finish(1, '', PREFIX + JSON.stringify(field) + ' is not a field of item ' + JSON.stringify(title) + '.');",
  '        return;',
  '      }',
  "      finish(0, item.fields[field] + '\\n', '');",
  '      return;',
  '    }',
  "    if (sub2 === 'create') {",
  "      if (scenario === 'failcreate') {",
  "        finish(1, '', '[ERROR] could not create item: the server rejected the request');",
  '        return;',
  '      }',
  '      readStdin().then(function (raw) {',
  '        var parsed;',
  '        try { parsed = JSON.parse(raw); } catch (e) {',
  "          finish(1, '', '[ERROR] failed to parse the item template: invalid JSON');",
  '          return;',
  '        }',
  '        var cvault = flag(\'--vault\');',
  '        if (state.vaults.indexOf(cvault) < 0) {',
  "          finish(1, '', absentVault(cvault));",
  '          return;',
  '        }',
  '        var fields = {};',
  '        var list = parsed.fields || [];',
  '        for (var k = 0; k < list.length; k++) { fields[list[k].label] = list[k].value; }',
  '        state.items.push({ title: parsed.title, vault: cvault, fields: fields });',
  '        save();',
  "        finish(0, '{\"id\":\"fake-' + state.items.length + '\",\"title\":' + JSON.stringify(parsed.title) + '}\\n', '');",
  '      });',
  '      return;',
  '    }',
  "    if (sub2 === 'delete') {",
  '      var dtitle = args[2];',
  '      var dvault = flag(\'--vault\');',
  '      var didx = -1;',
  '      for (var m = 0; m < state.items.length; m++) {',
  '        if (state.items[m].title === dtitle && state.items[m].vault === dvault) { didx = m; break; }',
  '      }',
  '      if (didx < 0) {',
  "        finish(1, '', absentItem(dtitle, dvault));",
  '        return;',
  '      }',
  '      state.items.splice(didx, 1);',
  '      save();',
  "      finish(0, '', '');",
  '      return;',
  '    }',
  "    finish(1, '', '[ERROR] fake op: unsupported item subcommand');",
  '    return;',
  '  }',
  "  finish(1, '', '[ERROR] fake op: unsupported command');",
  '}',
  '',
  'main();',
  '',
].join('\n');
