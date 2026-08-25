import { join } from 'node:path';
import { inspectAiderConf } from './aider.js';
import { inspectAgentsMd } from './agents-md.js';
import { inspectCodexProject } from './codex.js';
import { inspectContinueProject } from './continue.js';
import { inspectCopilotSettings } from './copilot.js';
import { inspectCursorMcp } from './cursor.js';
import { inspectGooseProject } from './goose.js';
import { inspectMcpServersFile, mcpWiringState, type McpInspection } from './mcp.js';
import { inspectZedSettings } from './zed.js';

export type AgentWiringMcp = 'ok' | 'missing' | 'spawn_failed';
export type AgentWiringInstructions = 'ok' | 'missing';

export type AgentWiring = {
  mcp: AgentWiringMcp;
  instructions: AgentWiringInstructions;
};

export type PrimaryHostInspection = {
  wiring: AgentWiring;
  mcp?: McpInspection;
  /** Hosts where MCP is expected in a project file. */
  mcpRequired: boolean;
  /** Documented as print-only / not OOTB even after init. */
  notOotb: boolean;
  /** Aider: `.env` appears on the `read:` list. */
  aiderUnsafe: boolean;
  message: string;
};

const MCP_REQUIRED = new Set([
  'cursor',
  'claude-code',
  'windsurf',
  'cline',
  'zed',
  'jetbrains',
  'copilot',
  'continue',
  'codex',
  'goose',
]);

const NOT_OOTB = new Set(['continue', 'goose']);

function inspectPrimaryMcp(
  root: string,
  hostId: string,
  options: { probe?: boolean; platform?: NodeJS.Platform },
): McpInspection | undefined {
  switch (hostId) {
    case 'cursor':
      return inspectCursorMcp(root, options);
    case 'claude-code':
      return inspectMcpServersFile(join(root, '.mcp.json'), '.mcp.json', options);
    case 'windsurf':
      return inspectMcpServersFile(
        join(root, '.windsurf', 'mcp_config.json'),
        '.windsurf/mcp_config.json',
        options,
      );
    case 'cline':
      return inspectMcpServersFile(
        join(root, '.cline', 'mcp_settings.json'),
        '.cline/mcp_settings.json',
        options,
      );
    case 'zed':
      return inspectZedSettings(root, options);
    case 'jetbrains':
      return inspectMcpServersFile(join(root, '.idea', 'mcp.json'), '.idea/mcp.json', options);
    case 'copilot':
      return inspectCopilotSettings(root, options);
    case 'continue':
      return inspectContinueProject(root);
    case 'codex':
      return inspectCodexProject(root);
    case 'goose':
      return inspectGooseProject(root);
    default:
      return undefined;
  }
}

export function inspectPrimaryHostWiring(
  root: string,
  hostId: string,
  options: { probe?: boolean; platform?: NodeJS.Platform } = {},
): PrimaryHostInspection {
  const instructions = inspectAgentsMd(root).instructions;
  const mcpRequired = MCP_REQUIRED.has(hostId);
  const notOotb = NOT_OOTB.has(hostId);

  if (hostId === 'aider') {
    const aider = inspectAiderConf(root);
    return {
      wiring: { mcp: 'ok', instructions },
      mcpRequired: false,
      notOotb: false,
      aiderUnsafe: !aider.wired,
      message: aider.message,
    };
  }

  if (!mcpRequired) {
    return {
      wiring: { mcp: 'ok', instructions },
      mcpRequired: false,
      notOotb: false,
      aiderUnsafe: false,
      message:
        instructions === 'ok'
          ? 'Layer 1 instructions present (AGENTS.md).'
          : 'AGENTS.md is missing the envseal imperative (never read .env; use envseal ensure / envseal run). Run `envseal init`.',
    };
  }

  const inspection = inspectPrimaryMcp(root, hostId, options) ?? {
    wired: false,
    status: 'missing' as const,
    commandOk: null,
    message: `No project MCP config for host ${hostId}. Run \`envseal init\`.`,
  };

  return {
    wiring: {
      mcp: mcpWiringState(inspection),
      instructions,
    },
    mcp: inspection,
    mcpRequired: true,
    notOotb,
    aiderUnsafe: false,
    message: inspection.message,
  };
}

export function wiringFailsDoctor(inspection: PrimaryHostInspection): boolean {
  if (inspection.mcpRequired && inspection.wiring.mcp !== 'ok') return true;
  if (inspection.wiring.instructions === 'missing') return true;
  if (inspection.aiderUnsafe) return true;
  return false;
}
