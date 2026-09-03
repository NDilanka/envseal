import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ENVSEAL_MCP_SERVER_NAME,
  isRecord,
  mcpLaunch,
  parseJsonObject,
  writeJson,
  isEmptyEnvsealStub,
  isStockNpxLaunch,
  looksLikeEnvsealServer,
  probeVersion,
  type McpInspection,
  type McpWriteAction,
} from './mcp.js';

function asServerList(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value;
}

function entryName(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  if (typeof entry.name === 'string') return entry.name;
  return undefined;
}

export function mergeCopilotSettings(
  root: string,
  platform: NodeJS.Platform = process.platform,
): { action: McpWriteAction; path: string } {
  const path = join(root, '.vscode', 'settings.json');
  const launch = { name: ENVSEAL_MCP_SERVER_NAME, ...mcpLaunch(platform) };

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeJson(path, { 'github.copilot.mcp': [launch] });
    return { action: 'created', path };
  }

  const parsed = parseJsonObject(readFileSync(path, 'utf8'));
  if (parsed === null) {
    return { action: 'skipped', path };
  }

  const existing = asServerList(parsed['github.copilot.mcp']);
  if (parsed['github.copilot.mcp'] !== undefined && existing === undefined) {
    return { action: 'skipped', path };
  }

  const list = existing === undefined ? [] : [...existing];
  const index = list.findIndex((item) => entryName(item) === ENVSEAL_MCP_SERVER_NAME);

  if (index === -1) {
    list.push(launch);
    writeJson(path, { ...parsed, 'github.copilot.mcp': list });
    return { action: 'merged', path };
  }

  const current = list[index];
  if (isEmptyEnvsealStub(current) || isStockNpxLaunch(current)) {
    if (isStockNpxLaunch(current) && isRecord(current) && current.command === launch.command) {
      return { action: 'unchanged', path };
    }
    list[index] = isRecord(current) ? { ...current, ...launch } : launch;
    writeJson(path, { ...parsed, 'github.copilot.mcp': list });
    return { action: 'merged', path };
  }

  return { action: 'unchanged', path };
}

export function inspectCopilotSettings(
  root: string,
  options: { probe?: boolean; platform?: NodeJS.Platform } = {},
): McpInspection {
  const path = join(root, '.vscode', 'settings.json');
  const hint =
    'Run `envseal init` to merge github.copilot.mcp with envseal-mcp (npx @envseal/mcp-server). [VERIFY]';

  if (!existsSync(path)) {
    return {
      wired: false,
      status: 'absent',
      commandOk: null,
      message: `.vscode/settings.json is missing. ${hint}`,
    };
  }

  const parsed = parseJsonObject(readFileSync(path, 'utf8'));
  if (parsed === null) {
    return {
      wired: false,
      status: 'unreadable',
      commandOk: null,
      message: `.vscode/settings.json is not valid JSON. ${hint}`,
    };
  }

  const list = asServerList(parsed['github.copilot.mcp']);
  if (list === undefined || list.length === 0) {
    return {
      wired: false,
      status: 'missing',
      commandOk: null,
      message: `.vscode/settings.json has no github.copilot.mcp envseal entry. ${hint}`,
    };
  }

  const entry = list.find((item) => entryName(item) === ENVSEAL_MCP_SERVER_NAME);
  // Names only, never entry values: a sibling argv or env block can hold a
  // real credential, and doctor output must not become a new exfil channel.
  const otherServers = list
    .map((item) => entryName(item))
    .filter((name): name is string => name !== undefined && name !== ENVSEAL_MCP_SERVER_NAME)
    .sort();
  if (entry === undefined || isEmptyEnvsealStub(entry) || !looksLikeEnvsealServer(entry)) {
    return {
      wired: false,
      status: entry === undefined ? 'missing' : 'stub',
      commandOk: null,
      otherServers,
      message: `.vscode/settings.json github.copilot.mcp has no working envseal-mcp. ${hint}`,
    };
  }

  const rec = entry as Record<string, unknown>;
  const commandOk = options.probe === true ? probeVersion(rec) : null;
  let message = 'Copilot MCP is wired (project .vscode/settings.json github.copilot.mcp). [VERIFY]';
  if (commandOk === false) {
    message =
      'Copilot MCP is configured, but the launch command did not report a version. Run `envseal init`. [VERIFY]';
  }
  return { wired: true, status: 'wired', commandOk, otherServers, message };
}
