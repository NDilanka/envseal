import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ProtectionTier = 'A' | 'B' | 'C';

export interface HostInfo {
  id: string;
  name: string;
  tier: ProtectionTier;
  reason: string;
  recommendation: string;
}

/**
 * Detect the host environment from marker files and env vars.
 * Tier A: protocol + interception hooks (Claude Code)
 * Tier B: protocol + advisory guardrails (Cursor, Continue, generic)
 * Tier C: protocol only (Aider, unknown)
 */
export function detectHost(root: string): HostInfo {
  const claudeDir = join(root, '.claude');
  const cursorDir = join(root, '.cursor');
  const continueDir = join(root, '.continue');
  const agentsFile = join(root, 'AGENTS.md');

  // Tier A: Claude Code
  if (existsSync(claudeDir) || process.env.CLAUDECODE) {
    return {
      id: 'claude-code',
      name: 'Claude Code',
      tier: 'A',
      reason: 'Found .claude/ directory or CLAUDECODE environment variable',
      recommendation:
        'Tier A host with full protocol + interception hooks. Secrets are maximally protected.',
    };
  }

  // Tier B: Cursor
  if (existsSync(cursorDir) || process.env.CURSOR_WORKSPACE || process.env.CURSOR_VERSION) {
    return {
      id: 'cursor',
      name: 'Cursor',
      tier: 'B',
      reason: 'Found .cursor/ directory or CURSOR_* environment variable',
      recommendation:
        'Tier B host with protocol + advisory guardrails only. Shell-command leaks are possible; prefer the keychain sink so .env holds only references.',
    };
  }

  // Tier B: Continue
  if (existsSync(continueDir)) {
    return {
      id: 'continue',
      name: 'Continue',
      tier: 'B',
      reason: 'Found .continue/ directory',
      recommendation:
        'Tier B host with protocol + advisory guardrails only. Shell-command leaks are possible; prefer the keychain sink so .env holds only references.',
    };
  }

  // Tier C: Aider
  const aiderConfPatterns = ['aider', '.aider'];
  const aiderMarkerExists = aiderConfPatterns.some(
    (pattern) =>
      existsSync(join(root, `${pattern}.conf.yml`)) ||
      existsSync(join(root, `${pattern}.conf.yaml`)) ||
      existsSync(join(root, `${pattern}.conf.json`)),
  );

  if (aiderMarkerExists) {
    return {
      id: 'aider',
      name: 'Aider',
      tier: 'C',
      reason: 'Found .aider configuration file',
      recommendation:
        'Tier C host with protocol only. No interception hooks available; prefer the keychain sink so .env holds only references.',
    };
  }

  // Tier B: Generic (AGENTS.md alone)
  if (existsSync(agentsFile)) {
    return {
      id: 'generic',
      name: 'Generic Agent',
      tier: 'B',
      reason: 'Found AGENTS.md file',
      recommendation:
        'Tier B host with protocol + advisory guardrails only. Shell-command leaks are possible; prefer the keychain sink so .env holds only references.',
    };
  }

  // Unknown
  return {
    id: 'unknown',
    name: 'Unknown Host',
    tier: 'C',
    reason: 'Could not detect a known host environment',
    recommendation:
      'Tier C host with protocol only. No interception hooks available; prefer the keychain sink so .env holds only references.',
  };
}
