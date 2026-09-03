import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const ENVSEAL_MCP_PACKAGE = '@envseal/mcp-server';
export const ENVSEAL_MCP_SERVER_NAME = 'envseal-mcp';
export const NPX_ARGS = ['-y', ENVSEAL_MCP_PACKAGE] as const;

export type McpLaunch = {
  command: string;
  args: string[];
};

export type McpWriteAction = 'created' | 'merged' | 'unchanged' | 'skipped';
export type McpStatus = 'absent' | 'unreadable' | 'missing' | 'stub' | 'wired';

export type McpInspection = {
  wired: boolean;
  status: McpStatus;
  message: string;
  /** null when the launch command was not probed (npx is not side-effect free). */
  commandOk: boolean | null;
  /**
   * Names of co-registered MCP servers besides envseal-mcp. Names only, never
   * entry values: a sibling argv or env block can hold a real credential, and
   * doctor output must not become a new exfil channel. Undefined when the host
   * config shape carries no enumerable server list.
   */
  otherServers?: string[];
};

/**
 * Sorted names of every server in a `mcpServers`-style map except envseal-mcp.
 * Keys only: callers must never forward the entry values.
 */
export function siblingServerNames(servers: Record<string, unknown>): string[] {
  return Object.keys(servers)
    .filter((name) => name !== ENVSEAL_MCP_SERVER_NAME)
    .sort();
}

/**
 * Launch argv a host can spawn without a global `envseal-mcp` on PATH.
 * Project MCP uses the workspace as cwd — never bake `--project` in.
 */
export function mcpLaunch(platform: NodeJS.Platform = process.platform): McpLaunch {
  return {
    command: platform === 'win32' ? 'npx.cmd' : 'npx',
    args: [...NPX_ARGS],
  };
}

export function mcpSnippetJson(platform: NodeJS.Platform = process.platform): string {
  const launch = mcpLaunch(platform);
  return JSON.stringify({
    mcpServers: { [ENVSEAL_MCP_SERVER_NAME]: launch },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function argsList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

/** Old shipped stub: `envseal-mcp` with no args. Host launchers do not search node_modules/.bin. */
export function isEmptyEnvsealStub(entry: unknown): boolean {
  if (!isRecord(entry)) return true;
  const command = entry.command;
  if (typeof command !== 'string' || command.trim() === '') return true;
  if (command !== 'envseal-mcp') return false;
  const args = argsList(entry.args);
  return args === undefined || args.length === 0;
}

/** Our npx snippet, either platform variant, and nothing else in command/args. */
export function isStockNpxLaunch(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const command = entry.command;
  if (command !== 'npx' && command !== 'npx.cmd') return false;
  const args = argsList(entry.args);
  return (
    args !== undefined && args.length === NPX_ARGS.length && NPX_ARGS.every((a, i) => a === args[i])
  );
}

/** True when an entry would actually start @envseal/mcp-server (npx or a non-empty command). */
export function looksLikeEnvsealServer(entry: unknown): boolean {
  if (entry === undefined || isEmptyEnvsealStub(entry)) return false;
  if (!isRecord(entry)) return false;
  const command = entry.command;
  if (typeof command !== 'string' || command.trim() === '') return false;
  if (isStockNpxLaunch(entry)) return true;
  const joined = `${command} ${(argsList(entry.args) ?? []).join(' ')}`;
  return /@envseal\/mcp-server|envseal-mcp/i.test(joined);
}

export function nextEnvsealEntry(
  current: unknown,
  launch: McpLaunch,
): McpLaunch | Record<string, unknown> | null {
  if (current === undefined || isEmptyEnvsealStub(current)) {
    return launch;
  }
  if (isStockNpxLaunch(current) && isRecord(current)) {
    if (current.command === launch.command) return null;
    return { ...current, command: launch.command, args: launch.args };
  }
  return null;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Merge envseal-mcp into a file whose top-level key is `mcpServers`.
 * Never writes user-global configs; the caller passes a project path.
 */
export function mergeMcpServersFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): { action: McpWriteAction; path: string } {
  const launch = mcpLaunch(platform);

  if (!existsSync(path)) {
    writeJson(path, { mcpServers: { [ENVSEAL_MCP_SERVER_NAME]: launch } });
    return { action: 'created', path };
  }

  const parsed = parseJsonObject(readFileSync(path, 'utf8'));
  if (parsed === null) {
    return { action: 'skipped', path };
  }

  const existingServers = parsed.mcpServers;
  if (existingServers !== undefined && !isRecord(existingServers)) {
    return { action: 'skipped', path };
  }

  const servers: Record<string, unknown> =
    existingServers === undefined ? {} : { ...existingServers };
  const next = nextEnvsealEntry(servers[ENVSEAL_MCP_SERVER_NAME], launch);
  if (next === null) {
    return { action: 'unchanged', path };
  }

  servers[ENVSEAL_MCP_SERVER_NAME] = next;
  writeJson(path, { ...parsed, mcpServers: servers });
  return { action: 'merged', path };
}

export function classifyEntry(entry: unknown): 'missing' | 'stub' | 'wired' {
  if (entry === undefined) return 'missing';
  if (isEmptyEnvsealStub(entry)) return 'stub';
  if (!isRecord(entry)) return 'stub';
  const command = entry.command;
  if (typeof command !== 'string' || command.trim() === '') return 'stub';
  return 'wired';
}

/**
 * `--version` is side-effect free on the envseal-mcp binary. `npx -y` is not
 * (it may hit the network), so the default snippet is not probed.
 */
export function shouldProbeLaunch(entry: Record<string, unknown>): boolean {
  const command = entry.command;
  if (typeof command !== 'string') return false;
  if (command === 'npx' || command === 'npx.cmd') return false;
  return true;
}

export function probeVersion(entry: Record<string, unknown>): boolean | null {
  if (!shouldProbeLaunch(entry)) return null;
  const command = entry.command;
  if (typeof command !== 'string') return null;
  const args = argsList(entry.args) ?? [];
  const result = spawnSync(command, [...args, '--version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return false;
  if (result.status !== 0) return false;
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return /envseal-mcp/i.test(out);
}

function initHint(platform: NodeJS.Platform, label: string): string {
  return `Run \`envseal init\` to write it, or merge ${mcpSnippetJson(platform)} into ${label}.`;
}

export function inspectMcpServersFile(
  path: string,
  label: string,
  options: { probe?: boolean; platform?: NodeJS.Platform } = {},
): McpInspection {
  const platform = options.platform ?? process.platform;
  const hint = initHint(platform, label);

  if (!existsSync(path)) {
    return {
      wired: false,
      status: 'absent',
      commandOk: null,
      message: `${label} is missing. ${hint}`,
    };
  }

  const parsed = parseJsonObject(readFileSync(path, 'utf8'));
  if (parsed === null) {
    return {
      wired: false,
      status: 'unreadable',
      commandOk: null,
      message: `${label} is not valid JSON. ${hint}`,
    };
  }

  const servers = parsed.mcpServers;
  if (servers === undefined || (isRecord(servers) && Object.keys(servers).length === 0)) {
    return {
      wired: false,
      status: 'missing',
      commandOk: null,
      message: `${label} has no envseal-mcp (empty mcpServers). ${hint}`,
    };
  }
  if (!isRecord(servers)) {
    return {
      wired: false,
      status: 'unreadable',
      commandOk: null,
      message: `${label} mcpServers is not an object. ${hint}`,
    };
  }

  const entry = servers[ENVSEAL_MCP_SERVER_NAME];
  const kind = classifyEntry(entry);
  const otherServers = siblingServerNames(servers);
  if (kind === 'missing') {
    return {
      wired: false,
      status: 'missing',
      commandOk: null,
      otherServers,
      message: `${label} has no envseal-mcp. ${hint}`,
    };
  }
  if (kind === 'stub') {
    return {
      wired: false,
      status: 'stub',
      commandOk: null,
      otherServers,
      message: `${label} envseal-mcp is the empty envseal-mcp stub (not on PATH for the host). ${hint}`,
    };
  }

  const rec = entry as Record<string, unknown>;
  const commandOk = options.probe === true ? probeVersion(rec) : null;
  let message = `MCP is wired (${label}).`;
  if (commandOk === false) {
    message = `MCP is configured in ${label}, but the launch command did not report a version. Run \`envseal init\` if the host cannot connect.`;
  }
  return { wired: true, status: 'wired', commandOk, otherServers, message };
}

/** Map an inspection to the doctor `agentWiring.mcp` field. */
export function mcpWiringState(inspection: McpInspection): 'ok' | 'missing' | 'spawn_failed' {
  if (inspection.commandOk === false) return 'spawn_failed';
  if (inspection.wired) return 'ok';
  return 'missing';
}
