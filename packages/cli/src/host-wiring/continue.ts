import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpLaunch, type McpInspection, type McpWriteAction } from './mcp.js';

export function continueSnippetYaml(platform: NodeJS.Platform = process.platform): string {
  const launch = mcpLaunch(platform);
  const args = launch.args.map((a) => `"${a}"`).join(', ');
  return `mcpServers:
  - name: envseal-mcp
    command: ${launch.command}
    args: [${args}]
`;
}

export function writeContinueProjectFiles(
  root: string,
  platform: NodeJS.Platform = process.platform,
): { action: McpWriteAction; path: string; printOnlyHint: string } {
  const dir = join(root, '.continue');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.yaml');
  const snippet = continueSnippetYaml(platform);
  const printOnlyHint =
    'Continue loads MCP from ~/.continue/config.yaml (global), not this project file. Merge the printed block into the global config; envseal does not write $HOME files. [VERIFY]';

  if (!existsSync(path)) {
    const body = `# Project copy of the envseal MCP snippet. Continue currently reads
# ~/.continue/config.yaml — merge the mcpServers block there. Do not copy this
# into $HOME from envseal init; this file exists so doctor can see the host.
#
# [VERIFY: recent Continue builds moved to a new HUB config schema; if a
# top-level mcpServers list is not accepted, use experimental.mcpServers.]

${snippet}`;
    writeFileSync(path, body, 'utf8');
    return { action: 'created', path, printOnlyHint };
  }

  const existing = readFileSync(path, 'utf8');
  if (/envseal-mcp/.test(existing) && /@envseal\/mcp-server|npx/.test(existing)) {
    return { action: 'unchanged', path, printOnlyHint };
  }
  if (/envseal-mcp/.test(existing)) {
    return { action: 'unchanged', path, printOnlyHint };
  }

  const trimmed = existing.replace(/\s+$/u, '');
  writeFileSync(path, `${trimmed}\n\n${snippet}`, 'utf8');
  return { action: 'merged', path, printOnlyHint };
}

export function inspectContinueProject(root: string): McpInspection {
  const path = join(root, '.continue', 'config.yaml');
  const hasSnippet = existsSync(path) && /envseal-mcp/.test(readFileSync(path, 'utf8'));
  // Continue's documented MCP file is ~/.continue/config.yaml. envseal never
  // writes $HOME, so project MCP is not OOTB regardless of the snippet file.
  return {
    wired: false,
    status: hasSnippet ? 'missing' : 'absent',
    commandOk: null,
    message:
      'Continue is not OOTB: merge the envseal mcpServers block into ~/.continue/config.yaml (envseal does not write $HOME). Project .continue/ is a detection marker + copy-paste snippet. [VERIFY]',
  };
}
