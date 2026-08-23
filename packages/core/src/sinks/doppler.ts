import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asSecret, SepError } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from '../paths.js';
import { CliSinkBase, execCli, exitCodeOf } from './cli-sink-base.js';
import type { CliExecOptions, CliExecResult } from './cli-sink-base.js';
import { unsafeSecretToUtf8 } from './dotenv.js';

/**
 * Doppler secrets live under a project/config pair, the provider's analog of
 * vault's mount/path: the project defaults to the sanitized project directory
 * name (same leaf keychain.ts and vault.ts scope by) and the config to `dev`,
 * both overridable per environment via ENVSEAL_DOPPLER_PROJECT /
 * ENVSEAL_DOPPLER_CONFIG. Overrides pass through verbatim — an explicit name
 * is aimed at an existing project, not renamed behind the user's back.
 *
 * Transport: `doppler secrets set KEY` reads the value from stdin when stdin
 * is a pipe (`cat cert.pem | doppler secrets set TLS_CERT` is the documented
 * form), so values never touch argv. The `KEY=value` argv form also exists
 * but is rejected here — argv is world-readable via process listings. The
 * other stdin route, `secrets upload` with a JSON blob, replaces the config's
 * whole secret set: scoping it to one key would mean a read-merge-upload
 * cycle that both pulls unrelated secrets through this process and races
 * concurrent writers into lost updates. One-key set through stdin has no
 * such race.
 *
 * Auth: DOPPLER_TOKEN in the environment or a token captured by
 * `doppler configure`. This sink never passes tokens itself.
 */

/** The config envseal writes to when ENVSEAL_DOPPLER_CONFIG does not override it. */
const DEFAULT_CONFIG = 'dev';

/**
 * Doppler documents no exit code for a missing secret; absence arrives as
 * stderr wording instead. Since DopplerHQ/cli PR #215 the CLI prints
 * `Could not find requested secret: NAME` and exits nonzero (older builds
 * returned an empty --plain body with exit 0, which read() maps to null) —
 * both shapes mean ABSENCE, which read()/remove() must report as null/false
 * rather than a thrown failure.
 *
 * The marker, not bare "not found", is what carries that meaning: scope
 * misses surface as their own errors (`project "x" not found`, `config
 * "dev" not found`), and mapping those to null would turn a mistyped
 * ENVSEAL_DOPPLER_PROJECT into an ensure() prompt loop on every run instead
 * of a loud error naming the bad scope. Any other nonzero exit (expired
 * token, unreachable API) stays loud for the same reason.
 */
const MISSING_SECRET = /could not find requested secrets?\b/i;

/**
 * True when a doppler credential exists: DOPPLER_TOKEN set, or a config file
 * on disk from a previous `doppler configure` (~/.doppler/.doppler.json, the
 * documented location). homedir() is resolved per call — os.homedir() honors
 * HOME/USERPROFILE, which lets tests isolate the file branch. The check also
 * degrades safely: a wrong guess about the path yields false (with an
 * unavailable message that names DOPPLER_TOKEN), never a false "ready".
 */
export function dopplerCredentialConfigured(): boolean {
  if (process.env.DOPPLER_TOKEN) return true;
  return existsSync(join(homedir(), '.doppler', '.doppler.json'));
}

/** The project directory name every other provider sink scopes entries by. */
function projectIdOf(paths: ProjectPaths): string {
  return paths.root.split(/[\\/]/).pop() ?? 'unknown';
}

/**
 * Map a project directory name onto doppler's project-name alphabet
 * (lowercase letters, digits, dashes, underscores). Best effort by design:
 * envseal never creates the project — the user provisions it under this name
 * or points ENVSEAL_DOPPLER_PROJECT at an existing one, and the first
 * operation fails loudly with doppler's own error if it does not exist.
 */
function sanitizeProjectName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'envseal-project';
}

/** The project/config pair every operation targets, resolved per call. */
function scopeFor(paths: ProjectPaths): { project: string; config: string } {
  return {
    project: process.env.ENVSEAL_DOPPLER_PROJECT ?? sanitizeProjectName(projectIdOf(paths)),
    config: process.env.ENVSEAL_DOPPLER_CONFIG ?? DEFAULT_CONFIG,
  };
}

/** Absence signal only: a real exit code plus doppler's missing-secret wording. */
function isNotFound(error: unknown): boolean {
  const stderr = (error as { stderr?: string } | null)?.stderr;
  return exitCodeOf(error) !== undefined && stderr !== undefined && MISSING_SECRET.test(stderr);
}

export class DopplerSink extends CliSinkBase {
  readonly id = 'doppler';

  protected readonly requiredCommands = ['doppler'];

  protected unavailableReason(): string {
    return 'the doppler CLI is not installed or no Doppler credential is configured (DOPPLER_TOKEN or doppler configure)';
  }

  /**
   * Single choke point for every spawn this sink makes. Production resolves
   * `doppler` off PATH; tests substitute a fake provider here instead of
   * staging one on PATH, because Windows cannot spawn shebang scripts and
   * modern Node refuses .cmd shims outright (CVE-2024-27980) — a PATH-only
   * double would leave the parsing/error-mapping logic unexercised there
   * (same trade as vault.ts).
   */
  protected run(args: readonly string[], options: CliExecOptions = {}): Promise<CliExecResult> {
    return execCli('doppler', [...args], options);
  }

  /**
   * Doppler on PATH AND a credential to talk to. The base probe deliberately
   * checks binaries only — credential configuration is validated here and at
   * operation time, where its absence can produce a precise message.
   */
  override async available(_paths: ProjectPaths): Promise<boolean> {
    return (await super.available(_paths)) && dopplerCredentialConfigured();
  }

  override async read(paths: ProjectPaths, key: string): Promise<SecretValue | null> {
    await this.requireReady();
    const scope = scopeFor(paths);
    try {
      const { stdout } = await this.run([
        'secrets',
        'get',
        key,
        '--plain',
        '--project',
        scope.project,
        '--config',
        scope.config,
      ]);
      // --plain prints the bare value plus one trailing newline; an empty body
      // is the exit-0 shape of a miss, the same read keychain.ts gives
      // secret-tool. Strip exactly that one newline, byte-exact, never a
      // blanket trim.
      if (stdout.length === 0) return null;
      return asSecret(Buffer.from(stdout.replace(/\r?\n$/, ''), 'utf8'));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.sinkFailure('read', error, key);
    }
  }

  override async write(paths: ProjectPaths, key: string, value: SecretValue): Promise<void> {
    await this.requireReady();
    const scope = scopeFor(paths);
    try {
      // Value on stdin only. One caveat left to the live round-trip suite
      // where a CLI exists: doppler may trim a single trailing newline off
      // piped input, echo-style — envseal values do not end in newlines in
      // practice, so nothing here pre-trims or pre-pads to compensate.
      await this.run(
        ['secrets', 'set', key, '--project', scope.project, '--config', scope.config],
        { input: unsafeSecretToUtf8(value) },
      );
    } catch (error) {
      throw this.sinkFailure('write', error, key);
    }
  }

  override async remove(paths: ProjectPaths, key: string): Promise<boolean> {
    await this.requireReady();
    const scope = scopeFor(paths);
    try {
      // --yes: the interactive confirmation can never be answered on a pipe.
      await this.run([
        'secrets',
        'delete',
        key,
        '--yes',
        '--project',
        scope.project,
        '--config',
        scope.config,
      ]);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw this.sinkFailure('remove', error, key);
    }
  }

  /**
   * Every operation re-probes the CLI — available() may have been consulted
   * long before, and the binary can vanish in between — then demands a
   * credential separately, whose absence gets its own precise message instead
   * of hiding behind the generic reason.
   */
  private async requireReady(): Promise<void> {
    await this.requirePrerequisites();
    if (!dopplerCredentialConfigured()) {
      throw new SepError({
        code: 'SEP_SINK_UNAVAILABLE',
        userMessage: `The ${this.id} sink is not available — no Doppler credential is configured (DOPPLER_TOKEN or doppler configure).`,
      });
    }
  }
}

export const dopplerSink = new DopplerSink();
