import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CURSOR_RULES_MDC } from './cursor-rules.js';
import {
  inspectMcpServersFile,
  mcpLaunch,
  mcpSnippetJson,
  mergeMcpServersFile,
  type McpInspection,
  type McpLaunch,
  type McpWriteAction,
} from './mcp.js';

export {
  ENVSEAL_MCP_PACKAGE,
  ENVSEAL_MCP_SERVER_NAME,
  isEmptyEnvsealStub,
  isStockNpxLaunch,
} from './mcp.js';

export type CursorMcpLaunch = McpLaunch;
export type CursorMcpWriteAction = McpWriteAction;
export type CursorRulesWriteAction = 'created' | 'unchanged';
export type CursorMcpStatus = McpInspection['status'];
export type CursorMcpInspection = McpInspection;

export type CursorWiringResult = {
  mcp: CursorMcpWriteAction;
  rules: CursorRulesWriteAction;
  mcpPath: string;
  rulesPath: string;
  /** Human one-liner: reload MCP. Empty when mcp write was skipped. */
  reloadHint: string;
};

const RELOAD_HINT = 'Reload MCP in Settings → MCP so Cursor picks up envseal-mcp.';

export function cursorMcpLaunch(platform: NodeJS.Platform = process.platform): CursorMcpLaunch {
  return mcpLaunch(platform);
}

export function cursorMcpSnippetJson(platform: NodeJS.Platform = process.platform): string {
  return mcpSnippetJson(platform);
}

export function writeCursorMcpJson(
  root: string,
  platform: NodeJS.Platform = process.platform,
): { action: CursorMcpWriteAction; path: string } {
  return mergeMcpServersFile(join(root, '.cursor', 'mcp.json'), platform);
}

export function writeCursorRules(root: string): { action: CursorRulesWriteAction; path: string } {
  const path = join(root, '.cursor', 'rules', 'envseal.mdc');
  if (existsSync(path)) {
    return { action: 'unchanged', path };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CURSOR_RULES_MDC, 'utf8');
  return { action: 'created', path };
}

export function writeCursorHostFiles(
  root: string,
  platform: NodeJS.Platform = process.platform,
): CursorWiringResult {
  const mcp = writeCursorMcpJson(root, platform);
  const rules = writeCursorRules(root);
  return {
    mcp: mcp.action,
    rules: rules.action,
    mcpPath: mcp.path,
    rulesPath: rules.path,
    reloadHint: mcp.action === 'skipped' ? '' : RELOAD_HINT,
  };
}

export function inspectCursorMcp(
  root: string,
  options: { probe?: boolean; platform?: NodeJS.Platform } = {},
): CursorMcpInspection {
  return inspectMcpServersFile(join(root, '.cursor', 'mcp.json'), '.cursor/mcp.json', options);
}
