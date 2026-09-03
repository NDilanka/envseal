import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENVSEAL_MCP_SERVER_NAME,
  isRecord,
  mcpLaunch,
  nextEnvsealEntry,
  parseJsonObject,
  writeJson,
  classifyEntry,
  probeVersion,
  siblingServerNames,
  type McpInspection,
  type McpWriteAction,
} from './mcp.js';

function zedHint(platform: NodeJS.Platform): string {
  const launch = mcpLaunch(platform);
  return `Run \`envseal init\` to merge { "mcp": { "${ENVSEAL_MCP_SERVER_NAME}": ${JSON.stringify(launch)} } } into .zed/settings.json. [VERIFY]`;
}

export function mergeZedSettings(
  root: string,
  platform: NodeJS.Platform = process.platform,
): { action: McpWriteAction; path: string } {
  const path = join(root, '.zed', 'settings.json');
  const launch = mcpLaunch(platform);

  if (!existsSync(path)) {
    writeJson(path, { mcp: { [ENVSEAL_MCP_SERVER_NAME]: launch } });
    return { action: 'created', path };
  }

  const parsed = parseJsonObject(readFileSync(path, 'utf8'));
  if (parsed === null) {
    return { action: 'skipped', path };
  }

  const existingMcp = parsed.mcp;
  if (existingMcp !== undefined && !isRecord(existingMcp)) {
    return { action: 'skipped', path };
  }

  const mcp: Record<string, unknown> = existingMcp === undefined ? {} : { ...existingMcp };
  const next = nextEnvsealEntry(mcp[ENVSEAL_MCP_SERVER_NAME], launch);
  if (next === null) {
    return { action: 'unchanged', path };
  }

  mcp[ENVSEAL_MCP_SERVER_NAME] = next;
  writeJson(path, { ...parsed, mcp });
  return { action: 'merged', path };
}

export function inspectZedSettings(
  root: string,
  options: { probe?: boolean; platform?: NodeJS.Platform } = {},
): McpInspection {
  const platform = options.platform ?? process.platform;
  const path = join(root, '.zed', 'settings.json');
  const hint = zedHint(platform);

  if (!existsSync(path)) {
    return {
      wired: false,
      status: 'absent',
      commandOk: null,
      message: `.zed/settings.json is missing. ${hint}`,
    };
  }

  const parsed = parseJsonObject(readFileSync(path, 'utf8'));
  if (parsed === null) {
    return {
      wired: false,
      status: 'unreadable',
      commandOk: null,
      message: `.zed/settings.json is not valid JSON. ${hint}`,
    };
  }

  const mcp = parsed.mcp;
  if (mcp === undefined || (isRecord(mcp) && Object.keys(mcp).length === 0)) {
    return {
      wired: false,
      status: 'missing',
      commandOk: null,
      message: `.zed/settings.json has no envseal-mcp under mcp. ${hint}`,
    };
  }
  if (!isRecord(mcp)) {
    return {
      wired: false,
      status: 'unreadable',
      commandOk: null,
      message: `.zed/settings.json mcp is not an object. ${hint}`,
    };
  }

  const entry = mcp[ENVSEAL_MCP_SERVER_NAME];
  const kind = classifyEntry(entry);
  const otherServers = siblingServerNames(mcp);
  if (kind === 'missing') {
    return {
      wired: false,
      status: 'missing',
      commandOk: null,
      otherServers,
      message: `.zed/settings.json has no envseal-mcp. ${hint}`,
    };
  }
  if (kind === 'stub') {
    return {
      wired: false,
      status: 'stub',
      commandOk: null,
      otherServers,
      message: `.zed/settings.json envseal-mcp is the empty stub. ${hint}`,
    };
  }

  const rec = entry as Record<string, unknown>;
  const commandOk = options.probe === true ? probeVersion(rec) : null;
  let message = 'Zed MCP is wired (project .zed/settings.json). [VERIFY: schema]';
  if (commandOk === false) {
    message =
      'Zed MCP is configured, but the launch command did not report a version. Run `envseal init`. [VERIFY]';
  }
  return { wired: true, status: 'wired', commandOk, otherServers, message };
}
