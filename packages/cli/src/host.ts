import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
/**
 * Are envseal's interception hooks actually wired into Claude Code?
 *
 * Deliberately evidence-based rather than optimistic. We look for envseal named
 * in a settings file's hook configuration, or an installed plugin directory. If
 * we cannot see the wiring we do not claim it — an unfounded tier A tells the
 * user that `cat .env` is blocked when it is not, and they will act accordingly.
 */
function envsealHooksInstalled(root: string): boolean {
  const candidates = [
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
    join(homedir(), '.claude', 'settings.json'),
  ];
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      // The hook commands reference the plugin by name whichever way it was
      // installed (marketplace, path, or a hand-written hooks block).
      if (/envseal/i.test(text) && /hooks/i.test(text)) return true;
    } catch {
      // Unreadable or absent: absence of evidence is not evidence of protection.
    }
  }
  // A locally installed plugin directory also counts.
  for (const dir of [
    join(root, '.claude', 'plugins', 'envseal'),
    join(homedir(), '.claude', 'plugins', 'envseal'),
  ]) {
    if (existsSync(dir)) return true;
  }
  return false;
}

export function detectHost(root: string): HostInfo {
  const claudeDir = join(root, '.claude');
  const cursorDir = join(root, '.cursor');
  const continueDir = join(root, '.continue');
  const agentsFile = join(root, 'AGENTS.md');

  // Claude Code. Detecting the HOST is not the same as detecting the PROTECTION:
  // tier A is earned by envseal's interception hooks actually being installed, and
  // `CLAUDECODE` being set only says which harness is running. Claiming "secrets
  // are maximally protected" on the strength of an environment variable is the
  // precise dishonesty this tier system exists to prevent — a user who believes
  // the hooks are guarding them behaves as if `cat .env` is blocked when it is not.
  if (existsSync(claudeDir) || process.env.CLAUDECODE) {
    if (envsealHooksInstalled(root)) {
      return {
        id: 'claude-code',
        name: 'Claude Code',
        tier: 'A',
        reason: 'Claude Code detected and envseal interception hooks are installed',
        recommendation:
          'Tier A: the protocol plus interception hooks. Reads of .env and env-dumping commands are blocked, and pasted keys are redacted before the model sees them.',
      };
    }
    return {
      id: 'claude-code',
      name: 'Claude Code',
      tier: 'B',
      reason:
        'Claude Code detected, but envseal interception hooks were not found in .claude/settings.json or ~/.claude/settings.json',
      recommendation:
        'Tier B until the plugin is installed: the protocol works, but nothing blocks a shell command from reading .env. Install the plugin in plugins/claude-code for tier A, or prefer the keychain sink so .env holds only references.',
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
