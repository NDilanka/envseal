import { existsSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { asSecret, SepError } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import { ensureStateDir } from '../paths.js';
import type { ProjectPaths } from '../paths.js';
import { CliSinkBase, execCli } from './cli-sink-base.js';
import type { CliExecOptions, CliExecResult } from './cli-sink-base.js';

/**
 * The sidecar this sink owns: a flat `KEY: value` YAML map at the project
 * root whose values are always SOPS ciphertext. A sibling of `.env` rather
 * than a resident of `.envseal/` because the point of the sops sink is an
 * encrypted store that is reviewable and backupable like any artifact — but
 * it must never be COMMITTED by accident (see assertGitSafe below), only
 * deliberately.
 */
const SIDECAR_NAME = '.env.sealsops.yaml';

/**
 * Plaintext staging happens inside `.envseal/` (mode 0700, gitignored — see
 * residual-risks §7): sops edits files in place, so encrypting means writing
 * plaintext somewhere first. The state dir already has both properties the
 * staging file needs.
 *
 * Plaintext lifetime per operation: serialize -> stage -> sops rewrites the
 * staged file in place as ciphertext -> ciphertext moves to the sidecar ->
 * staging directory removed in finally. No secret ever sits at the sidecar
 * path, on argv, or in any log.
 */

/** Flat `KEY: value` map with single-line values — dotenv semantics in YAML clothing. */
interface FlatMap {
  [key: string]: string;
}

function sidecarPath(paths: ProjectPaths): string {
  return join(paths.root, SIDECAR_NAME);
}

/**
 * Same refusal dotenv.ts applies to `.env`, aimed at the sidecar: inside a
 * git work tree the file must be ignored and untracked before any write.
 * Duplicated rather than exported because dotenv's version is private by
 * design and this check is six lines.
 */
function assertGitSafe(paths: ProjectPaths): void {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: paths.root,
      stdio: 'ignore',
    });
  } catch {
    return; // not a git repo — nothing to protect against
  }
  const relPath = relative(paths.root, sidecarPath(paths));
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
      cwd: paths.root,
      stdio: 'ignore',
    });
    throw new SepError({ code: 'SEP_GITIGNORE_UNSAFE' });
  } catch (error) {
    if (error instanceof SepError) throw error;
    // nonzero from ls-files = not tracked — continue to the ignore check
  }
  try {
    execFileSync('git', ['check-ignore', '-q', relPath], { cwd: paths.root, stdio: 'ignore' });
  } catch {
    throw new SepError({ code: 'SEP_GITIGNORE_UNSAFE' });
  }
}

/**
 * Parse the flat subset of YAML this sink writes: comments, blank lines, and
 * `KEY: value` where value may be double-quoted. SOPS-encrypted values are
 * single-line scalars (`KEY: ENC[AES256_GCM,data:...,type:str]`) so the rest-
 * of-line rule covers them; multi-line scalars would need a real parser and
 * are neither produced by serializeFlat nor accepted back. Nested blocks —
 * sops writes its metadata under a top-level `sops:` key — are skipped by the
 * key-shape test rather than parsed.
 */
function parseFlat(yamlText: string): FlatMap {
  const map: FlatMap = {};
  for (const line of yamlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.endsWith(':')) continue;
    const colonAt = line.indexOf(':');
    if (colonAt === -1) continue;
    const key = line.slice(0, colonAt).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue; // nested keys under sops: etc.
    let value = line.slice(colonAt + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

function serializeFlat(map: FlatMap): string {
  return (
    Object.entries(map)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n') + '\n'
  );
}

export class SopsSink extends CliSinkBase {
  readonly id = 'sops';

  protected readonly requiredCommands = ['sops'];

  protected unavailableReason(): string {
    return (
      'the sops CLI is not installed or no encryption target is configured '
      + '(.sops.yaml creation rules at the project root or ENVSEAL_SOPS_AGE_RECIPIENT)'
    );
  }

  /**
   * Single choke point for every spawn this sink makes, overridable in tests
   * exactly like vault.ts's — Windows cannot spawn shebang scripts, so the
   * scripted harness substitutes at this seam instead of staging a fake on
   * PATH and leaving argv construction unexercised here.
   */
  protected run(args: readonly string[], options: CliExecOptions = {}): Promise<CliExecResult> {
    return execCli('sops', [...args], options);
  }

  /**
   * sops needs a binary AND an encryption target it can resolve: creation
   * rules from `<root>/.sops.yaml`, or an age recipient passed via --age from
   * ENVSEAL_SOPS_AGE_RECIPIENT. DEcryption additionally needs the matching
   * private key, which sops discovers itself (SOPS_AGE_KEY, SOPS_AGE_KEY_FILE,
   * or its default config location) — unverifiable without attempting an
   * operation, so the honest boundary is: available() says "this sink could
   * store", and a missing identity fails loudly at operation time.
   */
  override async available(paths: ProjectPaths): Promise<boolean> {
    if (!(await super.available(paths))) return false;
    return existsSync(join(paths.root, '.sops.yaml')) || process.env.ENVSEAL_SOPS_AGE_RECIPIENT !== undefined;
  }

  /**
   * Encrypts the staged plaintext IN PLACE, so the invocation carries only a
   * path — never bytes. With .sops.yaml present its creation rules apply
   * untouched; otherwise --age carries the configured recipient.
   */
  private async encryptInPlace(stagedPath: string, paths: ProjectPaths): Promise<void> {
    const args = ['--encrypt', '--input-type', 'yaml', '--output-type', 'yaml'];
    if (!existsSync(join(paths.root, '.sops.yaml'))) {
      const recipient = process.env.ENVSEAL_SOPS_AGE_RECIPIENT;
      if (recipient === undefined) {
        throw new SepError({
          code: 'SEP_SINK_UNAVAILABLE',
          userMessage: `The ${this.id} sink is not available — no .sops.yaml creation rules at the project root and ENVSEAL_SOPS_AGE_RECIPIENT is unset.`,
        });
      }
      args.push('--age', recipient);
    }
    args.push(stagedPath);
    await this.run(args);
  }

  /** Decrypts the staged ciphertext IN PLACE; stdout/stderr stay diagnostics-only. */
  private async decryptInPlace(stagedPath: string): Promise<void> {
    await this.run(['--decrypt', '--input-type', 'yaml', '--output-type', 'yaml', stagedPath]);
  }

  /**
   * Copies the current sidecar (or starts empty) into a fresh staging dir
   * under .envseal/, runs the operation against the staged path, and removes
   * the directory on every path out — a leaked plaintext temp would outlive
   * the operation's purpose.
   */
  private async withStagedSidecar(
    paths: ProjectPaths,
    operate: (staged: string) => Promise<void>,
  ): Promise<void> {
    ensureStateDir(paths);
    const stagingDir = mkdtempSync(join(paths.stateDir, 'sops-'));
    const staged = join(stagingDir, 'sidecar.yaml');
    try {
      const file = sidecarPath(paths);
      if (existsSync(file)) copyFileSync(file, staged);
      else writeFileSync(staged, '', { mode: 0o600 });
      await operate(staged);
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  override async read(paths: ProjectPaths, key: string): Promise<SecretValue | null> {
    try {
      await this.requireReady(paths);
      const file = sidecarPath(paths);
      if (!existsSync(file)) return null;
      let map: FlatMap = {};
      await this.withStagedSidecar(paths, async (staged) => {
        await this.decryptInPlace(staged);
        map = parseFlat(readFileSync(staged, 'utf8'));
      });
      const value = map[key];
      if (value === undefined) return null;
      return asSecret(Buffer.from(value, 'utf8'));
    } catch (error) {
      throw this.sinkFailure('read', error, key);
    }
  }

  override async write(paths: ProjectPaths, key: string, value: SecretValue): Promise<void> {
    try {
      await this.requireReady(paths);
      assertGitSafe(paths);
      await this.withStagedSidecar(paths, async (staged) => {
        // An existing staged sidecar is ciphertext and must be decrypted back
        // before merging; a first-ever write stages an empty file that sops
        // must never be pointed at.
        if (existsSync(staged) && readFileSync(staged, 'utf8').trim() !== '') {
          await this.decryptInPlace(staged);
        }
        const map = parseFlat(readFileSync(staged, 'utf8'));
        map[key] = value.toString('utf8');
        writeFileSync(staged, serializeFlat(map), { mode: 0o600 });
        await this.encryptInPlace(staged, paths);
        writeFileSync(sidecarPath(paths), readFileSync(staged), { mode: 0o600 });
      });
    } catch (error) {
      throw this.sinkFailure('write', error, key);
    }
  }

  override async remove(paths: ProjectPaths, key: string): Promise<boolean> {
    try {
      await this.requireReady(paths);
      const file = sidecarPath(paths);
      if (!existsSync(file)) return false;
      let removed = false;
      await this.withStagedSidecar(paths, async (staged) => {
        await this.decryptInPlace(staged);
        const map = parseFlat(readFileSync(staged, 'utf8'));
        if (!(key in map)) return;
        delete map[key];
        removed = true;
        if (Object.keys(map).length === 0) {
          // Last entry gone: an encrypted file holding nothing is noise, not a store.
          rmSync(file);
          return;
        }
        writeFileSync(staged, serializeFlat(map), { mode: 0o600 });
        await this.encryptInPlace(staged, paths);
        writeFileSync(file, readFileSync(staged), { mode: 0o600 });
      });
      return removed;
    } catch (error) {
      throw this.sinkFailure('remove', error, key);
    }
  }

  /**
   * Prerequisite probe plus the encryption-target check, whose absence gets a
   * precise message instead of hiding behind the generic reason. Unlike the
   * other sinks there is no server to authenticate to — what can be cheaply
   * verified is binary + target; the decryption identity is sops' own
   * discovery problem and fails loudly at operation time.
   */
  private async requireReady(paths: ProjectPaths): Promise<void> {
    await this.requirePrerequisites();
    if (!existsSync(join(paths.root, '.sops.yaml')) && process.env.ENVSEAL_SOPS_AGE_RECIPIENT === undefined) {
      throw new SepError({
        code: 'SEP_SINK_UNAVAILABLE',
        userMessage: `The ${this.id} sink is not available — no .sops.yaml creation rules at the project root and ENVSEAL_SOPS_AGE_RECIPIENT is unset.`,
      });
    }
  }
}

export const sopsSink = new SopsSink();
