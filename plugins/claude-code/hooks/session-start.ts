import { findProjectRoot, loadManifest, projectPaths, resolvePresence } from '@envseal/core';
import { readPayload, writeResult } from './lib.js';

/**
 * §8.3 — Session-start hook.
 *
 * Presence check at session start; if any required keys are missing, emit a
 * context message so the model knows to collect them. Fail-open: any error
 * yields an empty context message.
 */

export interface SessionInput {
  projectRoot?: string;
  cwd?: string;
  workspaceRoot?: string;
  [key: string]: unknown;
}

export async function computeContext(root: string): Promise<string> {
  try {
    const paths = projectPaths(root);
    const manifest = loadManifest(paths);
    if (manifest === null) {
      return '';
    }
    const required = manifest.entries.filter((entry) => entry.required !== false);
    if (required.length === 0) {
      return '';
    }
    // Sink-aware: keychain-declared keys are resolved through their sink, so a
    // stored credential counts as present instead of re-prompting forever.
    const presence = await resolvePresence(
      paths,
      required.map((entry) => entry.key),
      { sinks: new Map(required.map((entry) => [entry.key, entry.sink ?? 'dotenv'])) },
    );
    const missing = required
      .filter((entry) => presence.get(entry.key)?.present === false)
      .map((entry) => entry.key);
    if (missing.length === 0) {
      return '';
    }
    return (
      `${missing.length} required environment variable${missing.length === 1 ? '' : 's'} are unset: ` +
      `${missing.join(', ')}. Use \`env_request\` to collect them.`
    );
  } catch {
    return '';
  }
}

/**
 * Claude Code's SessionStart contract: context is injected from
 * `hookSpecificOutput.additionalContext`. The previous shape nested
 * `hookSpecificOutput` inside itself and used a `contextMessage` key that
 * Claude Code does not read, so the missing-keys note never reached the model.
 *
 * See https://code.claude.com/docs/en/hooks (SessionStart output).
 */
export interface SessionStartHookOutput {
  hookSpecificOutput: {
    hookEventName: 'SessionStart';
    additionalContext: string;
  };
}

export function toHookOutput(contextMessage: string): SessionStartHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: contextMessage,
    },
  };
}

export async function run(): Promise<void> {
  try {
    const payload = await readPayload<SessionInput>();
    const root =
      payload.projectRoot ?? payload.workspaceRoot ?? payload.cwd ?? process.cwd();
    const contextMessage = await computeContext(findProjectRoot(root));
    writeResult(toHookOutput(contextMessage));
  } catch {
    writeResult(toHookOutput(''));
  }
}

if (process.argv[1] !== undefined) {
  const isMain = /session-start(?:\.cjs|\.js|\.ts)?$/.test(process.argv[1]);
  if (isMain) {
    run().catch(() => {
      writeResult(toHookOutput(''));
    });
  }
}
