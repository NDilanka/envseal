import { createHmac } from 'node:crypto';
import type {
  ManifestEntry,
  ManifestStatus,
  Ticket,
  TicketOutcome,
  VerifyResult,
  ExecResult,
  RevokeResult,
  RevokeResults,
  EnvDeclareInput,
  EnvRequestInput,
  EnvAwaitInput,
  EnvVerifyInput,
  EnvUseInput,
  EnvRevokeInput,
  DeclareResult,
  KeyStatus,
} from '@envseal/protocol';
import { SepError, isSepError, zero } from '@envseal/protocol';
import { getProvider, findKey } from '@envseal/registry';
import type { Prompter } from '@envseal/prompters';
import { selectPrompter } from '@envseal/prompters';

import { projectPaths, loadOrCreateSalt } from './paths.js';
import { loadManifest, declareEntries, emptyManifest } from './manifest.js';
import { resolvePresence } from './presence.js';
import { TicketStore } from './tickets.js';
import { appendAudit } from './audit.js';
import { verifyKey } from './verify.js';
import type { VerifyOptions } from './verify.js';
import { runWithSecrets } from './exec.js';
import type { ExecOptions } from './exec.js';
import { getSink } from './sinks/registry.js';
import { getValidation, recordValidation } from './validation-state.js';
import { scanText, secretInRequestError } from './guard.js';



function getLengthBucket(length: number): string {
  if (length < 8) return '<8';
  if (length < 16) return '8-16';
  if (length < 32) return '16-32';
  if (length < 48) return '32-48';
  if (length < 64) return '48-64';
  if (length < 128) return '64-128';
  return '128+';
}

function computeFingerprint(value: Buffer, salt: Buffer): string {
  const hmac = createHmac('sha256', salt);
  hmac.update(value);
  const digest = hmac.digest('hex');
  return `fp_${digest.slice(0, 8)}`;
}

export interface BrokerOptions {
  root: string;
  prompter?: Prompter;
  onConfirm?: ExecOptions['onConfirm'];
  onApprovalNeeded?: VerifyOptions['onApprovalNeeded'];
}

export class Broker {
  private readonly paths: ReturnType<typeof projectPaths>;
  private prompter: Prompter | null;
  private prompterPromise: Promise<Prompter> | null;
  private readonly ticketStore: TicketStore;
  private readonly onConfirm: ExecOptions['onConfirm'] | undefined;
  private readonly onApprovalNeeded: VerifyOptions['onApprovalNeeded'] | undefined;
  private readonly salt: Buffer;

  constructor(opts: BrokerOptions) {
    this.paths = projectPaths(opts.root);
    this.ticketStore = new TicketStore();
    this.onConfirm = opts.onConfirm;
    this.onApprovalNeeded = opts.onApprovalNeeded;
    this.salt = loadOrCreateSalt(this.paths);
    this.prompter = opts.prompter ?? null;
    this.prompterPromise = opts.prompter ? null : selectPrompter();
  }

  private async getPrompter(): Promise<Prompter> {
    if (this.prompter) {
      return this.prompter;
    }
    if (this.prompterPromise) {
      this.prompter = await this.prompterPromise;
      return this.prompter;
    }
    throw new Error('Prompter not available');
  }

  async describe(): Promise<ManifestStatus> {
    const manifest = loadManifest(this.paths) ?? emptyManifest();
    // Sink-aware: a keychain-declared entry is only resolvable through its
    // sink, so presence must consult it or status would report present:false
    // forever (the write-only era bug).
    const presence = await resolvePresence(
      this.paths,
      manifest.entries.map((e) => e.key),
      { sinks: new Map(manifest.entries.map((e) => [e.key, e.sink ?? 'dotenv'])) },
    );

    const entries: KeyStatus[] = [];
    const missingRequired: string[] = [];

    for (const entry of manifest.entries) {
      const presenceInfo = presence.get(entry.key);
      const present = presenceInfo?.present ?? false;
      const value = presenceInfo?.value ?? null;

      const lengthBucket = value ? getLengthBucket(value.length) : '<8';
      const fingerprint = value ? computeFingerprint(value, this.salt) : 'unknown';

      // NEVER evaluate the manifest's format.pattern against the live value
      // here. That pattern is model-supplied via env_declare, so compiling it
      // against the secret and returning the boolean is an unlimited
      // chosen-predicate oracle — enough to reconstruct the value in a few
      // hundred calls. See validation-state.ts.
      //
      // Report the outcome recorded when the value was stored. If we have no
      // record for THIS value (e.g. it predates envseal, or was written by
      // hand), fall back to the registry's pattern, which is bundled data the
      // model cannot influence — and otherwise report unknown.
      let formatValid: boolean | null = null;
      if (present && value) {
        formatValid = getValidation(this.paths, entry.key, fingerprint);
        if (formatValid === null) {
          const trusted = findKey(entry.key)?.key.format?.pattern;
          if (trusted !== undefined) {
            formatValid = new RegExp(trusted).test(value.toString('utf8'));
          }
        }
      }

      const status: KeyStatus = {
        key: entry.key,
        declared: true,
        present,
        sink: entry.sink ?? 'dotenv',
        formatValid,
        lengthBucket,
        fingerprint,
        lastVerified: null,
        verifyResult: null,
        source: 'user-prompt',
        rotationDue: null,
      };

      entries.push(status);

      if (entry.required && !present) {
        missingRequired.push(entry.key);
      }
    }

    return {
      projectRoot: this.paths.root,
      manifestPath: this.paths.manifest,
      entries,
      missingRequired,
    };
  }

  async declare(input: EnvDeclareInput): Promise<DeclareResult> {
    const withDefaults = input.entries.map((entry) => {
      if (entry.format || entry.provider || entry.verify) {
        return entry;
      }

      // Look up by ENV VAR NAME, not provider id. `getProvider('OPENAI_API_KEY')`
      // never matches — provider ids are 'openai', 'stripe', … — so this path
      // silently filled in nothing, leaving a model-declared key with no format
      // validation, no signup link in the prompt, and no verify probe.
      const found = findKey(entry.key);
      if (!found) {
        return entry;
      }
      const { provider: registryEntry, key } = found;

      return {
        ...entry,
        format: entry.format ?? key.format,
        provider:
          entry.provider ??
          ({
            id: registryEntry.id,
            name: registryEntry.name,
            signupUrl: key.signupUrl,
            docsUrl: key.docsUrl,
            rotateUrl: key.rotateUrl,
          } as ManifestEntry['provider']),
        verify: entry.verify ?? key.verify,
      };
    });

    return declareEntries(this.paths, withDefaults);
  }

  async request(input: EnvRequestInput): Promise<Ticket> {
    // Before the manifest is even read: `reason` is free text that goes
    // verbatim into .envseal/audit.jsonl, which §4.1 says holds names only. A
    // credential pasted there must not mint a ticket, reach the prompter, or
    // appear in a log line — so nothing above this point may have a side effect.
    // `keys` is not scanned here; every key has already been through the
    // declare-time guard, and an undeclared one throws below.
    const reasonFinding = scanText('reason', input.reason, 'strict');
    if (reasonFinding !== null) {
      appendAudit(this.paths, {
        type: 'blocked',
        reason: 'secret_in_request',
        detail: `${reasonFinding.path}: ${reasonFinding.label}`,
      });
      throw secretInRequestError(reasonFinding);
    }

    const manifest = loadManifest(this.paths) ?? emptyManifest();
    const declaredKeys = new Set(manifest.entries.map((e) => e.key));

    for (const key of input.keys) {
      if (!declaredKeys.has(key)) {
        throw new SepError({
          code: 'SEP_NOT_DECLARED',
        });
      }
    }

    // Report the surface actually selected. Hardcoding 'loopback-browser' told
    // the caller a browser window had opened even when the resolved prompter was
    // `none` (CI) or a native dialog — so the model relayed instructions to the
    // user for a prompt that did not exist.
    const prompter = await this.getPrompter();
    const surface = prompter.id;

    // Refuse before minting a ticket when there is no way to ask a human.
    // Previously the `none` prompter threw inside startPrompt(), where a
    // catch-all turned it into `cancelled` — so in CI the model was told the
    // USER had declined, and the documented exit code 4 was unreachable.
    if (surface === 'none') {
      throw new SepError({
        code: 'SEP_NO_INTERACTIVE_SURFACE',
        userMessage:
          `No interactive surface is available to collect ${input.keys.join(', ')}. ` +
          'Provide these values out of band (CI secret store, keychain, or a pre-populated .env), ' +
          'or run in an environment with a browser or terminal.',
      });
    }

    const ticket = this.ticketStore.create({
      keys: input.keys,
      reason: input.reason,
      surface,
      ttlMs: 600000,
    });

    appendAudit(this.paths, {
      type: 'request',
      ticket: ticket.ticket,
      keys: input.keys,
      reason: input.reason,
      surface: ticket.surface,
    });

    this.startPrompt(ticket.ticket, input.keys, input.reason).catch(() => {});

    return {
      ticket: ticket.ticket,
      nonce: ticket.nonce,
      // Narrow rather than cast: the ticket stores the surface as a plain
      // string, but the protocol type is a union. An `as any` here would hide a
      // typo in a surface name until it reached a client.
      surface: ticket.surface as Ticket['surface'],
      expiresAt: new Date(ticket.expiresAt).toISOString(),
      // No 'none' branch: request() throws SEP_NO_INTERACTIVE_SURFACE before
      // reaching here, so a ticket always corresponds to a real prompt.
      userMessage:
        surface === 'loopback-browser'
          ? `A browser window has opened to collect ${input.keys.join(', ')}. Verify it shows code ${ticket.nonce} before typing anything.`
          : `A prompt has opened to collect ${input.keys.join(', ')}. Verify it shows code ${ticket.nonce}.`,
    };
  }

  private async startPrompt(ticketId: string, keys: string[], reason: string): Promise<void> {
    const manifest = loadManifest(this.paths) ?? emptyManifest();
    const ticket = this.ticketStore.get(ticketId);
    if (!ticket) return;

    const keyPrompts = keys.map((keyName) => {
      const entry = manifest.entries.find((e) => e.key === keyName);
      if (!entry) {
        return {
          key: keyName,
          description: '',
        };
      }

      return {
        key: keyName,
        description: entry.description,
        providerName: entry.provider?.name,
        signupUrl: entry.provider?.signupUrl,
        docsUrl: entry.provider?.docsUrl,
        formatHint: entry.format?.example,
        pattern: entry.format?.pattern,
        optional: !entry.required,
      };
    });

    const prompter = await this.getPrompter();
    const promptReq = {
      ticket: ticketId,
      nonce: ticket.nonce,
      projectRoot: this.paths.root,
      reason,
      keys: keyPrompts,
      timeoutMs: 600000,
    };

    try {
      const response = await prompter.prompt(promptReq);

      for (const result of response.results) {
        const entry = manifest.entries.find((e) => e.key === result.key);
        if (!entry) {
          // The value-handling region starts here, not at the sink: a result
          // for a key that is no longer in the manifest is dropped without a
          // sink write, and its buffer must not survive that drop either.
          if (result.outcome === 'entered') {
            zero(result.value);
          }
          continue;
        }

        if (result.outcome === 'entered') {
          if (entry.format?.pattern) {
            const pattern = new RegExp(entry.format.pattern);
            const valueStr = result.value.toString('utf8');
            if (!pattern.test(valueStr)) {
              this.ticketStore.setOutcome(ticketId, result.key, 'invalid_format');
              appendAudit(this.paths, {
                type: 'skipped',
                ticket: ticketId,
                key: result.key,
              });
              zero(result.value);
              continue;
            }
          }

          // Every exit from this region — including the sink write throwing
          // SEP_SINK_WRITE_FAILED — must zero the entered value. The catch
          // below records the failure but used to leave the buffer live in
          // the heap.
          try {
            const sink = getSink(entry.sink ?? 'dotenv');
            await sink.write(this.paths, result.key, result.value);

            const fingerprint = computeFingerprint(result.value, this.salt);
            // Record the outcome now, while we legitimately hold the value. This
            // is the only place format validation touches a secret; env_describe
            // afterwards reports THIS result rather than re-testing a pattern the
            // model may have changed in the meantime.
            recordValidation(this.paths, result.key, fingerprint, true);
            this.ticketStore.setOutcome(ticketId, result.key, 'stored');
            appendAudit(this.paths, {
              type: 'stored',
              ticket: ticketId,
              key: result.key,
              sink: sink.id,
              fingerprint,
            });
          } finally {
            zero(result.value);
          }
        } else if (result.outcome === 'skipped') {
          this.ticketStore.setOutcome(ticketId, result.key, 'skipped');
          appendAudit(this.paths, {
            type: 'skipped',
            ticket: ticketId,
            key: result.key,
          });
        } else if (result.outcome === 'cancelled') {
          this.ticketStore.setOutcome(ticketId, result.key, 'cancelled');
          appendAudit(this.paths, {
            type: 'cancelled',
            ticket: ticketId,
            key: result.key,
          });
        } else if (result.outcome === 'timeout') {
          this.ticketStore.setOutcome(ticketId, result.key, 'timeout');
          appendAudit(this.paths, {
            type: 'timeout',
            ticket: ticketId,
            key: result.key,
          });
        }
      }

      this.ticketStore.resolve(ticketId);
    } catch (error) {
      // The prompt surface failed rather than the user declining. Record why,
      // so the distinction survives into the audit log even though the ticket
      // state cannot express it.
      appendAudit(this.paths, {
        type: 'blocked',
        reason: 'prompt_failed',
        detail: isSepError(error) ? error.code : 'unknown_prompter_error',
      });
      this.ticketStore.cancel(ticketId);
    }
  }

  async await(input: EnvAwaitInput): Promise<TicketOutcome> {
    return this.ticketStore.await(input.ticket, input.timeoutMs ?? 90000);
  }

  async verify(input: EnvVerifyInput): Promise<VerifyResult[]> {
    const manifest = loadManifest(this.paths) ?? emptyManifest();
    const results: VerifyResult[] = [];

    for (const keyName of input.keys) {
      const entry = manifest.entries.find((e) => e.key === keyName);
      if (!entry) {
        results.push({
          key: keyName,
          result: 'no_probe',
          message: 'Key not found in manifest',
          checkedAt: new Date().toISOString(),
        });
        continue;
      }

      const sink = getSink(entry.sink ?? 'dotenv');
      const value = await sink.read(this.paths, keyName);

      if (!value) {
        results.push({
          key: keyName,
          result: 'no_probe',
          message: 'Key not stored',
          checkedAt: new Date().toISOString(),
        });
        continue;
      }

      const result = await verifyKey(this.paths, entry, value, {
        onApprovalNeeded: this.onApprovalNeeded,
      });

      results.push(result);
      zero(value);
    }

    return results;
  }

  async use(input: EnvUseInput): Promise<ExecResult> {
    const manifest = loadManifest(this.paths) ?? emptyManifest();
    const secrets = new Map<string, import('@envseal/protocol').SecretValue>();

    for (const keyName of input.keys) {
      const entry = manifest.entries.find((e) => e.key === keyName);
      if (!entry) continue;

      const sink = getSink(entry.sink ?? 'dotenv');
      const value = await sink.read(this.paths, keyName);

      if (value) {
        secrets.set(keyName, value);
      }
    }

    const result = await runWithSecrets(input.command, secrets, {
      onConfirm: this.onConfirm,
      // The project's standing egress rule: allowlist mode refuses
      // non-allowlisted network targets before any dialog opens.
      egressPolicy: manifest.policy?.egress,
      // Execution auditing (use / use_result) is wired here so the product
      // path records every attempt in the chained audit log.
      auditPaths: this.paths,
    });

    for (const value of secrets.values()) {
      zero(value);
    }

    return result;
  }

  async revoke(input: EnvRevokeInput): Promise<RevokeResults> {
    const manifest = loadManifest(this.paths) ?? emptyManifest();
    const results: RevokeResult[] = [];

    for (const keyName of input.keys) {
      const entry = manifest.entries.find((e) => e.key === keyName);
      if (!entry) continue;

      const sink = getSink(entry.sink ?? 'dotenv');
      const removed = await sink.remove(this.paths, keyName);

      // Fall back to the registry. A manifest entry commonly carries only
      // `provider.id` — a model declaring a key has no reason to type out the
      // rotation URL — and returning null there defeats the field's whole
      // purpose, which is telling the user where to invalidate a burned key.
      let rotateUrl: string | null = entry.provider?.rotateUrl ?? null;
      if (rotateUrl === null && entry.provider?.id !== undefined) {
        rotateUrl = getProvider(entry.provider.id)?.keys.find((k) => k.envVar === keyName)
          ?.rotateUrl
          ?? getProvider(entry.provider.id)?.keys[0]?.rotateUrl
          ?? null;
      }
      if (rotateUrl === null) {
        rotateUrl = findKey(keyName)?.key.rotateUrl ?? null;
      }

      results.push({
        key: keyName,
        removed,
        rotateUrl,
      });

      appendAudit(this.paths, {
        type: 'revoke',
        key: keyName,
        sink: sink.id,
      });
    }

    return results;
  }

  dispose(): void {
    this.ticketStore.dispose();
  }
}
