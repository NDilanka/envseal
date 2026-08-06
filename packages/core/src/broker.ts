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
  EnvDescribeInput,
  EnvDeclareInput,
  EnvRequestInput,
  EnvAwaitInput,
  EnvVerifyInput,
  EnvUseInput,
  EnvRevokeInput,
  DeclareResult,
  KeyStatus,
} from '@envseal/protocol';
import { SepError, asSecret, zero } from '@envseal/protocol';
import { getProvider } from '@envseal/registry';
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

const LENGTH_BUCKETS = ['<8', '8-16', '16-32', '32-48', '48-64', '64-128', '128+'] as const;

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
    const presence = resolvePresence(this.paths, manifest.entries.map((e) => e.key));

    const entries: KeyStatus[] = [];
    const missingRequired: string[] = [];

    for (const entry of manifest.entries) {
      const presenceInfo = presence.get(entry.key);
      const present = presenceInfo?.present ?? false;
      const value = presenceInfo?.value ?? null;

      let formatValid = true;
      if (present && value && entry.format?.pattern) {
        const pattern = new RegExp(entry.format.pattern);
        const valueStr = value.toString('utf8');
        formatValid = pattern.test(valueStr);
      }

      const lengthBucket = value ? getLengthBucket(value.length) : '<8';
      const fingerprint = value ? computeFingerprint(value, this.salt) : 'unknown';

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
    const manifest = loadManifest(this.paths) ?? emptyManifest();

    const withDefaults = input.entries.map((entry) => {
      if (entry.format || entry.provider || entry.verify) {
        return entry;
      }

      const registryEntry = getProvider(entry.key);
      if (!registryEntry) {
        return entry;
      }

      const key = registryEntry.keys.find((k) => k.envVar === entry.key);
      if (!key) {
        return entry;
      }

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
    const manifest = loadManifest(this.paths) ?? emptyManifest();
    const declaredKeys = new Set(manifest.entries.map((e) => e.key));

    for (const key of input.keys) {
      if (!declaredKeys.has(key)) {
        throw new SepError({
          code: 'SEP_NOT_DECLARED',
        });
      }
    }

    const ticket = this.ticketStore.create({
      keys: input.keys,
      reason: input.reason,
      surface: 'loopback-browser',
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
      surface: ticket.surface as any,
      expiresAt: new Date(ticket.expiresAt).toISOString(),
      userMessage: `A request has been opened for ${input.keys.join(', ')}. Please respond to the prompt.`,
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
        if (!entry) continue;

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

          const sink = getSink(entry.sink ?? 'dotenv');
          await sink.write(this.paths, result.key, result.value);

          const fingerprint = computeFingerprint(result.value, this.salt);
          this.ticketStore.setOutcome(ticketId, result.key, 'stored');
          appendAudit(this.paths, {
            type: 'stored',
            ticket: ticketId,
            key: result.key,
            sink: sink.id,
            fingerprint,
          });

          zero(result.value);
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
    const secrets = new Map<string, any>();

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

      let rotateUrl: string | null = null;
      if (entry.provider?.rotateUrl) {
        rotateUrl = entry.provider.rotateUrl;
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
