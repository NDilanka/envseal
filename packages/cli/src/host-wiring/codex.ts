import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mcpLaunch, type McpInspection, type McpWriteAction } from './mcp.js';

export function codexTomlBlock(platform: NodeJS.Platform = process.platform): string {
  const launch = mcpLaunch(platform);
  const args = launch.args.map((a) => `"${a}"`).join(', ');
  return `[mcp_servers.envseal-mcp]
command = "${launch.command}"
args = [${args}]
`;
}

export function writeCodexProjectConfig(
  root: string,
  platform: NodeJS.Platform = process.platform,
): { action: McpWriteAction; path: string } {
  const path = join(root, '.codex', 'config.toml');
  const block = `# envseal MCP — [VERIFY] Codex schema is still moving. Prefer project
# .codex/ over ~/.codex/config.toml (global cwd is $HOME).
${codexTomlBlock(platform)}`;

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, block, 'utf8');
    return { action: 'created', path };
  }

  const existing = readFileSync(path, 'utf8');
  if (/mcp_servers\.envseal-mcp|envseal-mcp/.test(existing)) {
    return { action: 'unchanged', path };
  }

  const trimmed = existing.replace(/\s+$/u, '');
  writeFileSync(path, `${trimmed}\n\n${block}`, 'utf8');
  return { action: 'merged', path };
}

export function inspectCodexProject(root: string): McpInspection {
  const path = join(root, '.codex', 'config.toml');
  const hint =
    'Run `envseal init` to write project .codex/config.toml. [VERIFY] Codex may still only read ~/.codex/config.toml — envseal does not write $HOME.';

  if (!existsSync(path)) {
    return {
      wired: false,
      status: 'absent',
      commandOk: null,
      message: `.codex/config.toml is missing. ${hint}`,
    };
  }

  const text = readFileSync(path, 'utf8');
  if (!/envseal-mcp/.test(text)) {
    return {
      wired: false,
      status: 'missing',
      commandOk: null,
      message: `.codex/config.toml has no envseal-mcp. ${hint}`,
    };
  }
  return {
    wired: true,
    status: 'wired',
    commandOk: null,
    message: 'Project .codex/config.toml names envseal-mcp. [VERIFY: Codex may ignore project files.]',
  };
}
