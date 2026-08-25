import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mergeAiderConf } from './aider.js';
import { mergeAgentsMd, type AgentsMdAction } from './agents-md.js';
import { writeCodexProjectConfig } from './codex.js';
import { writeContinueProjectFiles, continueSnippetYaml } from './continue.js';
import { mergeCopilotSettings } from './copilot.js';
import { writeCursorHostFiles, type CursorWiringResult } from './cursor.js';
import { writeGooseMarker, gooseYamlSnippet } from './goose.js';
import { mergeMcpServersFile, type McpWriteAction } from './mcp.js';
import { mergeZedSettings } from './zed.js';

export type HostWiringEntry = {
  id: string;
  action: McpWriteAction | 'printed';
  path?: string;
  hint: string;
  extra?: Record<string, unknown>;
};

export type ApplyWiringResult = {
  agentsMd: { action: AgentsMdAction; path: string };
  hosts: HostWiringEntry[];
  cursor?: CursorWiringResult;
  /** True when init wrote nothing host-specific besides AGENTS.md. */
  bareTerminal: boolean;
};

const RELOAD = 'Reload MCP / restart the host, then run `envseal doctor`.';

function mcpServersWrite(
  id: string,
  path: string,
  relative: string,
  platform: NodeJS.Platform,
  extraHint?: string,
): HostWiringEntry {
  const result = mergeMcpServersFile(path, platform);
  const skipped =
    result.action === 'skipped'
      ? ` Could not merge ${relative} (invalid JSON). Fix the file and re-run envseal init.`
      : '';
  return {
    id,
    action: result.action,
    path: result.path,
    hint: skipped || `${extraHint ?? ''} ${RELOAD}`.trim(),
  };
}

export function applyHostWiring(
  root: string,
  hostIds: string[],
  platform: NodeJS.Platform = process.platform,
): ApplyWiringResult {
  const agentsMd = mergeAgentsMd(root);
  const hosts: HostWiringEntry[] = [];
  let cursor: CursorWiringResult | undefined;

  const unique = [...new Set(hostIds)];
  const writesMcpHost = unique.some((id) =>
    [
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
      'aider',
    ].includes(id),
  );

  for (const id of unique) {
    switch (id) {
      case 'cursor': {
        cursor = writeCursorHostFiles(root, platform);
        hosts.push({
          id,
          action: cursor.mcp,
          path: cursor.mcpPath,
          hint:
            cursor.mcp === 'skipped'
              ? 'Could not merge .cursor/mcp.json (invalid JSON). Fix the file and re-run envseal init.'
              : cursor.reloadHint,
          extra: { mcp: cursor.mcp, rules: cursor.rules, rulesPath: cursor.rulesPath },
        });
        break;
      }
      case 'claude-code': {
        mkdirSync(join(root, '.claude'), { recursive: true });
        hosts.push(
          mcpServersWrite(
            id,
            join(root, '.mcp.json'),
            '.mcp.json',
            platform,
            'Wrote project .mcp.json (Tier B protocol). Restart Claude Code so it picks up envseal-mcp. Install plugins/claude-code for Tier A hooks — doctor reports A only when hooks are visible.',
          ),
        );
        break;
      }
      case 'windsurf': {
        hosts.push(
          mcpServersWrite(
            id,
            join(root, '.windsurf', 'mcp_config.json'),
            '.windsurf/mcp_config.json',
            platform,
            '[VERIFY] Windsurf MCP schema has shifted across releases.',
          ),
        );
        break;
      }
      case 'cline': {
        hosts.push(
          mcpServersWrite(
            id,
            join(root, '.cline', 'mcp_settings.json'),
            '.cline/mcp_settings.json',
            platform,
            '[VERIFY] Cline MCP schema.',
          ),
        );
        break;
      }
      case 'zed': {
        const result = mergeZedSettings(root, platform);
        hosts.push({
          id,
          action: result.action,
          path: result.path,
          hint:
            result.action === 'skipped'
              ? 'Could not merge .zed/settings.json (invalid JSON). Fix the file and re-run envseal init. [VERIFY]'
              : `[VERIFY] Zed MCP key shape. ${RELOAD}`,
        });
        break;
      }
      case 'jetbrains': {
        hosts.push(
          mcpServersWrite(
            id,
            join(root, '.idea', 'mcp.json'),
            '.idea/mcp.json',
            platform,
            '[VERIFY] JetBrains MCP location varies by product.',
          ),
        );
        break;
      }
      case 'copilot': {
        const result = mergeCopilotSettings(root, platform);
        hosts.push({
          id,
          action: result.action,
          path: result.path,
          hint:
            result.action === 'skipped'
              ? 'Could not merge .vscode/settings.json (invalid JSON). Fix the file and re-run envseal init. [VERIFY]'
              : `[VERIFY] github.copilot.mcp schema. ${RELOAD}`,
        });
        break;
      }
      case 'continue': {
        const result = writeContinueProjectFiles(root, platform);
        hosts.push({
          id,
          action: result.action,
          path: result.path,
          hint: `${result.printOnlyHint}\n\nMerge into ~/.continue/config.yaml:\n${continueSnippetYaml(platform)}`,
        });
        break;
      }
      case 'codex': {
        const result = writeCodexProjectConfig(root, platform);
        hosts.push({
          id,
          action: result.action,
          path: result.path,
          hint: `[VERIFY] Codex may still read ~/.codex/config.toml; envseal does not write $HOME. ${RELOAD}`,
        });
        break;
      }
      case 'goose': {
        const result = writeGooseMarker(root);
        hosts.push({
          id,
          action: 'printed',
          path: result.path,
          hint: `Goose is not OOTB. ${result.addHint}\n\nOr merge (unverified yaml):\n${gooseYamlSnippet(platform)}`,
        });
        break;
      }
      case 'aider': {
        const result = mergeAiderConf(root);
        hosts.push({
          id,
          action: result.action,
          path: result.path,
          hint: 'Merged Aider config so .env is not on the read list. Use /run envseal ensure.',
        });
        break;
      }
      case 'generic':
      case 'unknown':
      case 'openhands':
        hosts.push({
          id,
          action: 'printed',
          hint:
            id === 'openhands'
              ? 'OpenHands is deployment-dependent (binary inside sandbox, TTY for ensure). Layer 1 AGENTS.md is the working path.'
              : 'Layer 1 only (AGENTS.md). Any agent that reads instruction files can run envseal ensure / envseal run --.',
        });
        break;
      default:
        hosts.push({
          id,
          action: 'printed',
          hint: 'Unknown host: Layer 1 AGENTS.md only. Re-run from the IDE or `envseal init --host <name>`.',
        });
    }
  }

  return {
    agentsMd,
    hosts,
    cursor,
    bareTerminal: !writesMcpHost,
  };
}
