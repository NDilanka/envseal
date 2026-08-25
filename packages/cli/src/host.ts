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

/** Host ids `init --host` accepts. `openhands` is Layer 1 only. */
export const KNOWN_HOST_IDS = [
  'claude-code',
  'cursor',
  'continue',
  'aider',
  'windsurf',
  'cline',
  'zed',
  'codex',
  'jetbrains',
  'goose',
  'copilot',
  'generic',
  'unknown',
  'openhands',
] as const;

export type HostId = (typeof KNOWN_HOST_IDS)[number];

/**
 * Detect the host environment from marker files and env vars.
 * Tier A: protocol + interception hooks (Claude Code)
 * Tier B: protocol + advisory guardrails (Cursor, Continue, Windsurf, Cline,
 *   Zed, Codex, JetBrains, Copilot, generic)
 * Tier C: protocol only (Aider, Goose, unknown)
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

/**
 * Detection runs in TWO passes with a hard precedence rule:
 *
 *   Pass 1 — PROJECT-LOCAL evidence only (.claude/, .cursor/, aider.conf.yml, ...).
 *   Pass 2 — ENVIRONMENT and GLOBAL-HOME evidence (CLAUDECODE, ~/.codex,
 *            ~/.cline, ~/.config/zed, ...) runs ONLY when pass 1 found nothing.
 *
 * A machine where the developer happens to have Codex installed globally
 * (~/.codex exists) used to make EVERY bare directory report "Codex CLI, tier
 * B" — advice about interception and sinks for a project that has nothing to
 * do with that tool. A marker inside the project says something about THIS
 * project; a marker in $HOME only says something about the MACHINE, so it must
 * never outrank or substitute for project evidence.
 */

const TIER_B_ADVICE =
  'Tier B host with protocol + advisory guardrails only. Shell-command leaks are possible; prefer the keychain sink so .env holds only references.';
const TIER_C_ADVICE =
  'Tier C host with protocol only. No interception hooks available; prefer the keychain sink so .env holds only references.';

const AIDER_CONF_PATTERNS = ['aider', '.aider'];

export function aiderMarkerExists(root: string): boolean {
  return AIDER_CONF_PATTERNS.some(
    (pattern) =>
      existsSync(join(root, `${pattern}.conf.yml`)) ||
      existsSync(join(root, `${pattern}.conf.yaml`)) ||
      existsSync(join(root, `${pattern}.conf.json`)),
  );
}

export function copilotSettingsExist(root: string): boolean {
  const vscodeSettings = join(root, '.vscode', 'settings.json');
  try {
    return existsSync(vscodeSettings) && /copilot/i.test(readFileSync(vscodeSettings, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Every project-local host marker in this repo. Used by `init` so a dual-host
 * tree (`.cursor/` + `.claude/`) gets both configs. Does not include AGENTS.md
 * (Layer 1 is always applied) and does not scan `$HOME`.
 */
export function collectProjectHostIds(root: string): string[] {
  const ids: string[] = [];
  if (existsSync(join(root, '.claude'))) ids.push('claude-code');
  if (existsSync(join(root, '.cursor'))) ids.push('cursor');
  if (existsSync(join(root, '.continue'))) ids.push('continue');
  if (aiderMarkerExists(root)) ids.push('aider');
  if (existsSync(join(root, '.windsurf'))) ids.push('windsurf');
  if (existsSync(join(root, '.cline'))) ids.push('cline');
  if (existsSync(join(root, '.zed'))) ids.push('zed');
  if (existsSync(join(root, '.codex'))) ids.push('codex');
  if (existsSync(join(root, '.idea'))) ids.push('jetbrains');
  if (existsSync(join(root, 'goose.config.yaml')) || existsSync(join(root, '.goose'))) {
    ids.push('goose');
  }
  if (copilotSettingsExist(root)) ids.push('copilot');
  return ids;
}

/**
 * This-process host only. Used by `init` when the project has no markers.
 * Never treats a global `~/.cursor` / `~/.codex` install as this project.
 */
export function detectProcessHostId(): string | undefined {
  if (process.env.CLAUDECODE) return 'claude-code';
  if (process.env.CURSOR_WORKSPACE || process.env.CURSOR_VERSION) return 'cursor';
  if (process.env.CLINE_ROOT) return 'cline';
  if (process.env.ZED_EDITOR) return 'zed';
  if (process.env.CODEX_ROOT) return 'codex';
  if (process.env.GOOSE_ROOT) return 'goose';
  return undefined;
}

export function parseHostOverride(raw: string): string[] | { error: string } {
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    return { error: `unknown --host '${raw}'. Valid values: ${KNOWN_HOST_IDS.join(', ')}.` };
  }
  const unknown = ids.filter((id) => !KNOWN_HOST_IDS.includes(id as HostId));
  if (unknown.length > 0) {
    return {
      error: `unknown --host '${unknown.join(', ')}'. Valid values: ${KNOWN_HOST_IDS.join(', ')}.`,
    };
  }
  return ids;
}

/**
 * Which hosts `init` should write Layer 2 config for.
 * `--host` is an escape hatch (comma-separated ok). Never crawls `$HOME`.
 */
export function resolveInitHostIds(
  root: string,
  hostOverride?: string,
): {
  ids: string[];
  source: 'flag' | 'project' | 'process' | 'none';
  error?: string;
} {
  if (hostOverride !== undefined) {
    const parsed = parseHostOverride(hostOverride);
    if ('error' in parsed) {
      return { ids: [], source: 'flag', error: parsed.error };
    }
    return { ids: parsed, source: 'flag' };
  }
  const project = collectProjectHostIds(root);
  if (project.length > 0) {
    return { ids: project, source: 'project' };
  }
  const processId = detectProcessHostId();
  if (processId !== undefined) {
    return { ids: [processId], source: 'process' };
  }
  return { ids: [], source: 'none' };
}

export function detectHost(root: string): HostInfo {
  /* ---------------- Pass 1: project-local evidence ---------------- */

  // Claude Code. Detecting the HOST is not the same as detecting the PROTECTION:
  // tier A is earned by envseal's interception hooks actually being installed, and
  // `CLAUDECODE` being set only says which harness is running. Claiming "secrets
  // are maximally protected" on the strength of an environment variable is the
  // precise dishonesty this tier system exists to prevent — a user who believes
  // the hooks are guarding them behaves as if `cat .env` is blocked when it is not.
  if (existsSync(join(root, '.claude'))) {
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

  if (existsSync(join(root, '.cursor'))) {
    return {
      id: 'cursor',
      name: 'Cursor',
      tier: 'B',
      reason: 'Found .cursor/ directory',
      recommendation: TIER_B_ADVICE,
    };
  }

  if (existsSync(join(root, '.continue'))) {
    return {
      id: 'continue',
      name: 'Continue',
      tier: 'B',
      reason: 'Found .continue/ directory',
      recommendation: TIER_B_ADVICE,
    };
  }

  // Tier C: Aider (project-local config forms).
  if (aiderMarkerExists(root)) {
    return {
      id: 'aider',
      name: 'Aider',
      tier: 'C',
      reason: 'Found .aider configuration file',
      recommendation: TIER_C_ADVICE,
    };
  }

  if (existsSync(join(root, '.windsurf'))) {
    return {
      id: 'windsurf',
      name: 'Windsurf',
      tier: 'B',
      reason: 'Found .windsurf/ directory',
      recommendation: TIER_B_ADVICE,
    };
  }

  if (existsSync(join(root, '.cline'))) {
    return {
      id: 'cline',
      name: 'Cline',
      tier: 'B',
      reason: 'Found .cline/ directory',
      recommendation: TIER_B_ADVICE,
    };
  }

  if (existsSync(join(root, '.zed'))) {
    return {
      id: 'zed',
      name: 'Zed',
      tier: 'B',
      reason: 'Found .zed/ directory',
      recommendation: TIER_B_ADVICE,
    };
  }

  if (existsSync(join(root, '.codex'))) {
    return {
      id: 'codex',
      name: 'Codex CLI',
      tier: 'B',
      reason: 'Found .codex/ directory',
      recommendation: TIER_B_ADVICE,
    };
  }

  // Tier B: JetBrains IDEs (IntelliJ, PyCharm, ...).
  if (existsSync(join(root, '.idea'))) {
    return {
      id: 'jetbrains',
      name: 'JetBrains IDE',
      tier: 'B',
      reason: 'Found .idea/ directory',
      recommendation: TIER_B_ADVICE,
    };
  }

  // Tier C: Goose (project-local forms).
  if (existsSync(join(root, 'goose.config.yaml')) || existsSync(join(root, '.goose'))) {
    return {
      id: 'goose',
      name: 'Goose',
      tier: 'C',
      reason: 'Found goose.config.yaml or .goose/ directory',
      recommendation: TIER_C_ADVICE,
    };
  }

  // Tier B: GitHub Copilot agent. VS Code Copilot has no unique project
  // directory, so the honest marker is Copilot settings inside
  // .vscode/settings.json — a bare .vscode/ proves nothing, every VS Code
  // project has one.
  if (copilotSettingsExist(root)) {
    return {
      id: 'copilot',
      name: 'GitHub Copilot',
      tier: 'B',
      reason: 'Found .vscode/settings.json referencing Copilot',
      recommendation: TIER_B_ADVICE,
    };
  }

  // Tier B: Generic (AGENTS.md alone).
  if (existsSync(join(root, 'AGENTS.md'))) {
    return {
      id: 'generic',
      name: 'Generic Agent',
      tier: 'B',
      reason: 'Found AGENTS.md file',
      recommendation: TIER_B_ADVICE,
    };
  }

  /* ------------- Pass 2: environment / global-home evidence -------------
   * Reached ONLY when the project carries no marker of its own.
   *
   * Process env (CLAUDECODE, CURSOR_*, …) names the host running *this*
   * command. `$HOME` markers are labeling only — never a reason for `init`
   * to write files. `~/.codex/` is intentionally not treated as Codex (see
   * tests): a global install is not this project. `~/.codeium/windsurf`,
   * `~/.cline`, `~/.config/zed` lump to Generic Agent, not a named host.
   * `~/.continue/config.yaml` alone is Unknown, matching Continue docs. */

  if (process.env.CLAUDECODE) {
    return {
      id: 'claude-code',
      name: 'Claude Code',
      tier: 'B',
      reason: 'CLAUDECODE is set (running under Claude Code), no project markers found',
      recommendation:
        'Tier B until the plugin is installed: the protocol works, but nothing blocks a shell command from reading .env. Install the plugin in plugins/claude-code for tier A, or prefer the keychain sink so .env holds only references.',
    };
  }

  if (process.env.CURSOR_WORKSPACE || process.env.CURSOR_VERSION) {
    return {
      id: 'cursor',
      name: 'Cursor',
      tier: 'B',
      reason: 'CURSOR_* environment variable set, no project markers found',
      recommendation: TIER_B_ADVICE,
    };
  }

  if (process.env.CLINE_ROOT) {
    return {
      id: 'cline',
      name: 'Cline',
      tier: 'B',
      reason: 'CLINE_ROOT is set, no project markers found',
      recommendation: TIER_B_ADVICE,
    };
  }

  if (process.env.ZED_EDITOR) {
    return {
      id: 'zed',
      name: 'Zed',
      tier: 'B',
      reason: 'ZED_EDITOR is set, no project markers found',
      recommendation: TIER_B_ADVICE,
    };
  }

  if (process.env.CODEX_ROOT) {
    return {
      id: 'codex',
      name: 'Codex CLI',
      tier: 'B',
      reason: 'CODEX_ROOT is set, no project markers found',
      recommendation: TIER_B_ADVICE,
    };
  }

  if (
    existsSync(join(homedir(), '.codeium', 'windsurf')) ||
    existsSync(join(homedir(), '.cline')) ||
    existsSync(join(homedir(), '.config', 'zed')) ||
    existsSync(join(homedir(), '.zed'))
  ) {
    return {
      id: 'generic',
      name: 'Generic Agent',
      tier: 'B',
      reason:
        'No project markers found; a globally installed coding agent (Windsurf/Cline/Zed config in $HOME) is present',
      recommendation:
        'Advisory tier: the global install suggests an agent MAY act here, but nothing ties it to this project. The protocol still works; prefer the keychain sink so .env holds only references.',
    };
  }

  if (process.env.GOOSE_ROOT || existsSync(join(homedir(), '.config', 'goose'))) {
    return {
      id: 'goose',
      name: 'Goose',
      tier: 'C',
      reason: 'GOOSE_ROOT is set or global Goose config exists, no project markers found',
      recommendation: TIER_C_ADVICE,
    };
  }

  // Unknown.
  return {
    id: 'unknown',
    name: 'Unknown Host',
    tier: 'C',
    reason: 'Could not detect a known host environment',
    recommendation: TIER_C_ADVICE,
  };
}
