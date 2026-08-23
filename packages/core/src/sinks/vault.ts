import { SepError, asSecret } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from '../paths.js';
import { CliSinkBase, execCli, exitCodeOf } from './cli-sink-base.js';
import type { CliExecOptions, CliExecResult } from './cli-sink-base.js';
import { unsafeSecretToUtf8 } from './dotenv.js';

/**
 * The mount envseal writes into when ENVSEAL_VAULT_MOUNT does not override it.
 * A dedicated mount (kv-v2) keeps project secrets out of whatever else lives
 * under the provider's default namespace.
 */
const DEFAULT_MOUNT = 'secret';

/**
 * `vault kv get` reports a missing path as exit 2 ("No value found at ...").
 * Encoded from vault's documented CLI behavior: no vault exists on the
 * development machine this mapping was authored on, so the live round-trip
 * suite in vault-sink.test.ts is what confirms it wherever a server exists.
 */
const KV_NO_VALUE_FOUND = 2;

/** The exact stderr phrase vault prints for a missing path. */
const NO_VALUE_FOUND_MARKER = 'No value found';

/**
 * Exit 2 alone is NOT absence: the same code carries permission denied and
 * every other API error. Only the "No value found" marker on stderr does —
 * checking it keeps a forbidden path a loud SEP_SINK_WRITE_FAILED instead of
 * a silent null that would send ensure() back to the prompt.
 */
function documentedAbsence(error: unknown): boolean {
  if (exitCodeOf(error) !== KV_NO_VALUE_FOUND) return false;
  return ((error as { stderr?: string } | null)?.stderr ?? '').includes(NO_VALUE_FOUND_MARKER);
}

/** The mount name, resolved per call so tests can flip the override freely. */
function mountName(): string {
  return process.env.ENVSEAL_VAULT_MOUNT ?? DEFAULT_MOUNT;
}

/**
 * One server-side path PER KEY, scoped by project the way keychain.ts scopes
 * its account names: `envseal/<project-leaf>/<key>`. The key must ride in the
 * path, not sit beside its siblings as a field on a shared path: `vault kv
 * put` REPLACES the entire data map at the target and `kv delete` removes the
 * whole path, so shared-path storage would let every write silently destroy
 * every other key and any single remove destroy them all. Both sinks scope by
 * the leaf directory name of the project root, so two checkouts of one repo
 * stay separate unless they share a basename — the same trade keychain makes.
 */
function relativePath(paths: ProjectPaths, key: string): string {
  const projectId = paths.root.split(/[\\/]/).pop() ?? 'unknown';
  return `envseal/${projectId}/${key}`;
}

/**
 * Auth posture: the token reaches the CLI through its own discovery chain
 * (VAULT_TOKEN or ~/.vault-token); this sink never passes -token=, which
 * would put the credential in argv. Writes need create/update on
 * `<mount>/envseal/*`; reads need read on the same paths.
 */
export class VaultSink extends CliSinkBase {
  readonly id = 'vault';

  protected readonly requiredCommands = ['vault'];

  protected unavailableReason(): string {
    // A present-but-unaddressed binary (VAULT_ADDR unset) is indistinguishable
    // from a missing one until an operation runs, so the message names both.
    return 'the vault CLI is not installed or VAULT_ADDR is unset';
  }

  /**
   * Single choke point for every spawn this sink makes. Production resolves
   * `vault` off PATH; tests substitute a fake provider here instead of staging
   * one on PATH, because Windows cannot spawn shebang scripts directly and a
   * PATH-only double would leave the parsing/error-mapping logic unexercised
   * there (see vault-sink.test.ts).
   */
  protected run(args: readonly string[], options: CliExecOptions = {}): Promise<CliExecResult> {
    return execCli('vault', [...args], options);
  }

  /**
   * Vault on PATH AND an address to talk to. The base probe deliberately
   * checks binaries only — VAULT_ADDR-style configuration is validated here
   * and at operation time, where its absence can produce a precise message.
   */
  override async available(_paths: ProjectPaths): Promise<boolean> {
    return (await super.available(_paths)) && Boolean(process.env.VAULT_ADDR);
  }

  override async read(paths: ProjectPaths, key: string): Promise<SecretValue | null> {
    await this.requireReady();
    try {
      const { stdout } = await this.run([
        'kv',
        'get',
        '-field',
        key,
        '-mount',
        mountName(),
        relativePath(paths, key),
      ]);
      // -field prints the value plus one trailing newline; strip exactly that
      // one, byte-exact like keychain.ts — never a blanket trim, which would
      // corrupt a value that genuinely ends in whitespace. A stored value that
      // itself ends in a literal newline loses it here, the same trade every
      // newline-terminated CLI output in this codebase makes.
      return asSecret(Buffer.from(stdout.replace(/\r?\n$/, ''), 'utf8'));
    } catch (error) {
      if (documentedAbsence(error)) return null;
      throw this.sinkFailure('read', error, key);
    }
  }

  override async write(paths: ProjectPaths, key: string, value: SecretValue): Promise<void> {
    await this.requireReady();
    try {
      // `<KEY>=-` is vault's documented stdin form (`echo x | vault kv put
      // -mount=secret foo bar=-`): the bytes travel through the inherited
      // pipe until EOF, never argv where any process listing could read them.
      // Exactly one field reads stdin per call, so ordering quirks cannot mix
      // fields. -mount keeps the positional path relative, matching the
      // documented flag rather than baking the mount into the path string.
      await this.run(
        ['kv', 'put', '-mount', mountName(), relativePath(paths, key), `${key}=-`],
        { input: unsafeSecretToUtf8(value) },
      );
    } catch (error) {
      throw this.sinkFailure('write', error, key);
    }
  }

  override async remove(paths: ProjectPaths, key: string): Promise<boolean> {
    await this.requireReady();
    try {
      // kv delete (soft-deletes the latest version), never kv destroy: the
      // version history stays intact for audit, matching how the other sinks
      // treat removal as reversible-at-the-provider rather than shredding.
      await this.run(['kv', 'delete', '-mount', mountName(), relativePath(paths, key)]);
      // Current servers report success ("Data deleted (if it existed)...")
      // even when nothing was ever written, so true reflects what the tool
      // actually reported; the absence mapping below is defensive for builds
      // that surface a missing path the way kv get does.
      return true;
    } catch (error) {
      if (documentedAbsence(error)) return false;
      throw this.sinkFailure('remove', error, key);
    }
  }

  /**
   * Every operation re-probes the CLI — available() may have been consulted
   * long before, and the binary can vanish in between — then demands
   * VAULT_ADDR separately, whose absence gets its own precise message instead
   * of hiding behind the generic reason.
   */
  private async requireReady(): Promise<void> {
    await this.requirePrerequisites();
    if (!process.env.VAULT_ADDR) {
      throw new SepError({
        code: 'SEP_SINK_UNAVAILABLE',
        userMessage: `The ${this.id} sink is not available — VAULT_ADDR is unset.`,
      });
    }
  }
}

export const vaultSink = new VaultSink();
