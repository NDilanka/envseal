import { asSecret, SepError } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from '../paths.js';
import { CliCommandFailure, CliSinkBase, commandExists, execCli } from './cli-sink-base.js';
import { unsafeSecretToUtf8 } from './dotenv.js';

// One dedicated vault holds every envseal item, so the project-scoped titles
// below never collide with anything a user keeps in their personal vaults,
// and a cleanup sweep has an exact boundary.
const VAULT = 'envseal';
// Login is the one category every account and Connect deployment accepts;
// the field labels do the real naming work.
const CATEGORY = 'login';
const CREDENTIAL_FIELD = 'credential';
const KEY_FIELD = 'envseal-key';

/**
 * op ships no documented exit code for "absent" (unlike security's err 44),
 * so absence rides the provider's own error strings — the same route every
 * serious op wrapper takes. Every fragment stays anchored to an item/vault
 * noun so network noise like "host not found" can never pass for a missing
 * item:
 *
 *   `"t" isn't an item in the envseal vault.` / `"v" isn't a vault in this account.`
 */
const OP_ABSENCE_RE =
  /\bisn't an item\b|\bisn't a vault\b|\bno item found\b|\bno vault found\b|\b(?:item|vault)\b[^\n]{0,80}\bnot found\b/i;

function readsAsAbsent(error: unknown): boolean {
  return error instanceof CliCommandFailure && OP_ABSENCE_RE.test(error.stderr);
}

/** The title write() files this key under — per-project, like the keychain sink's account name. */
function itemTitleFor(paths: ProjectPaths, key: string): string {
  const projectId = paths.root.split(/[\\/]/).pop() ?? 'unknown';
  return `${projectId}:${key}`;
}

/**
 * The 1Password CLI adapter. Talks to `op` under whatever non-interactive
 * credential the environment carries — a service account token or Connect
 * host/token pair, which `op whoami` validates without ever triggering the
 * interactive unlock a signed-in desktop account would need.
 *
 * One item per credential in the dedicated vault: title `<projectId>:<KEY>`,
 * field `credential` carrying the value (CONCEALED, so 1Password treats it
 * as a secret), field `envseal-key` recording the raw key so items remain
 * attributable even after a project directory is renamed. The value reaches
 * `op item create` inside the item template on stdin (the positional `-`
 * form): op has no --fields-file, and field=value argv pairs land in process
 * listings, while stdin also beats a temp template file by keeping secret
 * bytes off disk entirely.
 */
export class OnePasswordSink extends CliSinkBase {
  readonly id = 'onepassword';

  protected readonly requiredCommands = ['op'];

  /**
   * Result of this instance's first `op whoami`, remembered for the
   * instance's lifetime: a credential validated at first use is trusted for
   * the session, and every operation skips the extra probe from then on. An
   * auth failure after that point surfaces through the operation's own error
   * mapping instead.
   */
  private whoamiOk: boolean | null = null;

  protected unavailableReason(): string {
    return 'the op CLI is not installed or no non-interactive 1Password credential is configured (OP_SERVICE_ACCOUNT_TOKEN or OP_CONNECT_HOST/OP_CONNECT_TOKEN)';
  }

  /**
   * Binary presence is not enough: op with no usable credential answers every
   * real command with an auth error. `op whoami` is the cheapest command that
   * tells the two states apart, and it only reports — it never prompts.
   */
  override async available(_paths: ProjectPaths): Promise<boolean> {
    if (!(await commandExists('op'))) return false;
    return this.whoamiSucceeds();
  }

  /**
   * The same probe at operation time: a session that expired (or a binary
   * that vanished) between available() and now must surface as
   * SEP_SINK_UNAVAILABLE — which names the fix — rather than as a cryptic
   * auth failure from deep inside `op item get`.
   */
  protected override async requirePrerequisites(): Promise<void> {
    await super.requirePrerequisites();
    if (!(await this.whoamiSucceeds())) {
      // The base keeps its unavailableError() private; restate its shape.
      throw new SepError({
        code: 'SEP_SINK_UNAVAILABLE',
        userMessage: `The ${this.id} sink is not available — ${this.unavailableReason()}.`,
      });
    }
  }

  private whoamiSucceeds(): Promise<boolean> {
    if (this.whoamiOk !== null) return Promise.resolve(this.whoamiOk);
    return execCli('op', ['whoami']).then(
      () => (this.whoamiOk = true),
      () => (this.whoamiOk = false),
    );
  }

  override async read(paths: ProjectPaths, key: string): Promise<SecretValue | null> {
    await this.requirePrerequisites();
    try {
      const { stdout } = await execCli('op', [
        'item',
        'get',
        itemTitleFor(paths, key),
        '--vault',
        VAULT,
        '--fields',
        CREDENTIAL_FIELD,
      ]);
      // A single --fields selector prints the bare value plus exactly one
      // trailing newline; trimming more would corrupt a value that genuinely
      // ends in whitespace.
      return asSecret(Buffer.from(stdout.replace(/\r?\n$/, ''), 'utf8'));
    } catch (error) {
      if (readsAsAbsent(error)) return null;
      throw this.sinkFailure('read', error, key);
    }
  }

  override async write(paths: ProjectPaths, key: string, value: SecretValue): Promise<void> {
    await this.requirePrerequisites();
    await this.ensureVault(key);

    const title = itemTitleFor(paths, key);

    // Replace = delete-then-create inside one logical write. A missing item
    // is the ordinary first-write case, not an error; anything else (an
    // ambiguous title, an unreachable server) stays loud, because stacking a
    // second item onto a store we do not understand only compounds the damage.
    try {
      await execCli('op', ['item', 'delete', title, '--vault', VAULT]);
    } catch (error) {
      if (!readsAsAbsent(error)) throw this.sinkFailure('write', error, key);
    }

    // Template on stdin (positional `-`) — template and stdin are mutually
    // exclusive, so no --template flag rides along.
    const template = JSON.stringify({
      title,
      category: CATEGORY,
      fields: [
        { label: CREDENTIAL_FIELD, type: 'CONCEALED', value: unsafeSecretToUtf8(value) },
        { label: KEY_FIELD, type: 'STRING', value: key },
      ],
    });

    try {
      await execCli('op', ['item', 'create', '--vault', VAULT, '-'], { input: template });
    } catch (error) {
      throw this.sinkFailure('write', error, key);
    }
  }

  /**
   * A first write on a fresh deployment has no vault yet. Restricted
   * credentials cannot help here — service accounts and Connect tokens may
   * only touch vaults granted to them, not mint new ones — so a failed
   * creation stays loud with the provider's stderr in the details: the fix
   * (pre-provision the vault and grant the credential) belongs to a human.
   */
  private async ensureVault(key: string): Promise<void> {
    try {
      await execCli('op', ['vault', 'get', VAULT]);
      return;
    } catch (error) {
      if (!readsAsAbsent(error)) throw this.sinkFailure('write', error, key);
    }
    try {
      await execCli('op', ['vault', 'create', VAULT]);
    } catch (error) {
      throw this.sinkFailure('write', error, key);
    }
  }

  override async remove(paths: ProjectPaths, key: string): Promise<boolean> {
    await this.requirePrerequisites();
    try {
      await execCli('op', ['item', 'delete', itemTitleFor(paths, key), '--vault', VAULT]);
      return true;
    } catch (error) {
      if (readsAsAbsent(error)) return false;
      throw this.sinkFailure('remove', error, key);
    }
  }
}

export const onepasswordSink = new OnePasswordSink();
