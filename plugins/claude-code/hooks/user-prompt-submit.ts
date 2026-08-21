import { detect, redactDetections } from '@envseal/detector';
import type { Detection } from '@envseal/detector';
import { findProjectRoot, projectPaths } from '@envseal/core';
import { getProvider } from '@envseal/registry';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readPayload, writeResult } from './lib.js';

/**
 * §8.2 — User-prompt-submit hook.
 *
 * Intercepts user input before it reaches the model and redacts any detected
 * secret, informing the user. This is the ONE hook that fails CLOSED: a crash
 * here would silently leak a pasted key to the model, so on any internal error
 * the message is scrubbed rather than passed through.
 */

export interface UserPromptResult {
  modifiedMessage: string;
  detected: boolean;
  bypassed: boolean;
  labels: string[];
  /** Terminal notice to print (never contains the secret value). */
  notice?: string;
}

export interface RedactOptions {
  /** One-shot bypass flag under .envseal/allow-once.lock (checked + deleted). */
  allowLockPath?: string;
}

const ALLOW_ONCE_MARKER = '/env:allow-once';

export function firstLineOf(message: string): string {
  const line = message.split(/\r?\n/, 1)[0] ?? '';
  return line.trim();
}

export function shouldBypassFirstLine(message: string): boolean {
  const line = firstLineOf(message);
  return line === ALLOW_ONCE_MARKER || line.startsWith(`${ALLOW_ONCE_MARKER} `);
}

export function consumeAllowOnceLock(path: string | undefined): void {
  if (path === undefined) {
    return;
  }
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Deleting a stale flag must never fail the hook.
  }
}

export function uniqueLabels(detections: Detection[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of detections) {
    if (!seen.has(d.label)) {
      seen.add(d.label);
      out.push(d.label);
    }
  }
  return out;
}

export function rotateUrlsFor(detections: Detection[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of detections) {
    if (d.providerId === undefined) continue;
    const provider = getProvider(d.providerId);
    if (provider === undefined) continue;
    for (const key of provider.keys) {
      if (key.rotateUrl !== undefined && !seen.has(key.rotateUrl)) {
        seen.add(key.rotateUrl);
        out.push(key.rotateUrl);
      }
    }
  }
  return out;
}

export function suggestedKeyFor(detections: Detection[]): string | undefined {
  for (const d of detections) {
    if (d.providerId === undefined) continue;
    const provider = getProvider(d.providerId);
    if (provider !== undefined && provider.keys.length > 0) {
      const firstKey = provider.keys[0];
      if (firstKey !== undefined) {
        return firstKey.envVar;
      }
    }
  }
  return undefined;
}

export function buildNotice(detections: Detection[]): string {
  const labels = uniqueLabels(detections);
  const urls = rotateUrlsFor(detections);
  const suggested = suggestedKeyFor(detections);
  const lines: string[] = [];
  lines.push(
    `[envseal] Detected a possible secret in your message${labels.length > 0 ? `: ${labels.join(', ')}` : ''}.`,
  );
  lines.push('[envseal] It was NOT sent to the model; it was replaced with «redacted-secret».');
  if (urls.length > 0) {
    lines.push('[envseal] If you ever pasted this key before envseal guarded this channel, rotate it now:');
    for (const url of urls) {
      lines.push(`[envseal]   ${url}`);
    }
  }
  if (suggested !== undefined) {
    lines.push(`[envseal] Run \`/env:set ${suggested}\` to store it properly instead of pasting it.`);
  } else {
    lines.push('[envseal] Run `/env:set <KEY>` to store it properly instead of pasting it.');
  }
  return lines.join('\n');
}

/** Fail-closed fallback: scrub high-entropy runs when the detector cannot run. */
export function scrubHighEntropy(message: string): string {
  return message.replace(/\b[A-Za-z0-9_\-+/=]{20,}\b/g, '«redacted-secret»');
}

export function redactUserMessage(message: string, options?: RedactOptions): UserPromptResult {
  if (shouldBypassFirstLine(message) || (options?.allowLockPath !== undefined && existsSync(options.allowLockPath))) {
    consumeAllowOnceLock(options?.allowLockPath);
    return { modifiedMessage: message, detected: false, bypassed: true, labels: [] };
  }

  try {
    const detections = detect(message);
    if (detections.length === 0) {
      return { modifiedMessage: message, detected: false, bypassed: false, labels: [] };
    }
    const modifiedMessage = redactDetections(message, detections);
    return {
      modifiedMessage,
      detected: true,
      bypassed: false,
      labels: uniqueLabels(detections),
      notice: buildNotice(detections),
    };
  } catch {
    // Fail closed: never route an uncertain message to the model untouched.
    return {
      modifiedMessage: scrubHighEntropy(message),
      detected: true,
      bypassed: false,
      labels: ['high-entropy string'],
      notice: buildNotice([
        { start: 0, end: 0, patternId: 'generic:high-entropy', confidence: 'medium', label: 'high-entropy string' },
      ]),
    };
  }
}

interface Payload {
  userMessage?: unknown;
  prompt?: unknown;
  cwd?: string;
  [key: string]: unknown;
}

/**
 * Claude Code's UserPromptSubmit contract.
 *
 * A UserPromptSubmit hook CANNOT rewrite the prompt — the documented output has
 * no `modifiedPrompt`/`updatedInput` field, only `decision: "block"` (which
 * erases the prompt before the model sees it) and
 * `hookSpecificOutput.additionalContext` (injected alongside it). The previous
 * version returned a `modifiedPrompt` nested inside a doubled
 * `hookSpecificOutput`; Claude Code read none of it, so the pasted key reached
 * the model verbatim while the hook exited 0.
 *
 * Redaction is therefore implemented as a BLOCK, not a rewrite: a detected
 * secret erases the prompt and returns a reason that names the detector labels
 * and rotation URLs but never the value. Fail-closed by construction — the only
 * two outcomes are "no secret detected, pass through" and "erased".
 *
 * Note also that for this event Claude Code adds the hook's stdout to context,
 * so the output must never carry the prompt back.
 *
 * See https://code.claude.com/docs/en/hooks (UserPromptSubmit output).
 */
export type UserPromptSubmitHookOutput =
  | { decision: 'block'; reason: string; systemMessage: string }
  | Record<string, never>;

export function toHookOutput(outcome: UserPromptResult): UserPromptSubmitHookOutput {
  if (!outcome.detected || outcome.bypassed) {
    return {};
  }
  const notice = outcome.notice ?? buildNotice([]);
  return {
    decision: 'block',
    reason:
      'envseal blocked this message: it contained what looks like a live credential' +
      `${outcome.labels.length > 0 ? ` (${outcome.labels.join(', ')})` : ''}. ` +
      'The message was not delivered. Ask the user to store the key with `/env:set <KEY>` ' +
      'and read it back through `env_use`; never ask them to paste it into the chat.',
    systemMessage: notice,
  };
}

export function run(): Promise<void> {
  return readPayload<Payload>()
    .then((payload) => {
      const raw =
        typeof payload.userMessage === 'string'
          ? payload.userMessage
          : typeof payload.prompt === 'string'
            ? payload.prompt
            : '';
      const root = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
      const lockPath = join(projectPaths(findProjectRoot(root)).stateDir, 'allow-once.lock');
      const outcome = redactUserMessage(raw, { allowLockPath: lockPath });
      if (outcome.notice !== undefined && outcome.detected && !outcome.bypassed) {
        process.stderr.write(outcome.notice + '\n');
      }
      return toHookOutput(outcome);
    })
    .then((result) => {
      writeResult(result);
    });
}

if (process.argv[1] !== undefined) {
  const isMain = /user-prompt-submit(?:\.cjs|\.js|\.ts)?$/.test(process.argv[1]);
  if (isMain) {
    run().catch(() => {
      // Fail closed: if we cannot tell whether this message holds a secret, the
      // message does not go to the model.
      writeResult({
        decision: 'block',
        reason:
          'envseal could not scan this message for credentials, so it was not delivered. ' +
          'Ask the user to resend it; if it contains a key, store it with `/env:set <KEY>` instead.',
        systemMessage: '[envseal] Secret scan failed; the message was blocked rather than sent.',
      });
    });
  }
}
