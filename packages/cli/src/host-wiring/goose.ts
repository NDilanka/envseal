import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpLaunch, type McpInspection, type McpWriteAction } from './mcp.js';

export function gooseYamlSnippet(platform: NodeJS.Platform = process.platform): string {
  const launch = mcpLaunch(platform);
  const args = launch.args.map((a) => `"${a}"`).join(', ');
  return `mcp:
  servers:
    envseal-mcp:
      cmd: ${launch.command}
      args: [${args}]
`;
}

export function gooseAddHint(platform: NodeJS.Platform = process.platform): string {
  const launch = mcpLaunch(platform);
  const args = launch.args.join(' ');
  return `goose mcp add envseal-mcp -- ${launch.command} ${args}   # [VERIFY: exact flags for your build]`;
}

/**
 * Goose is print-only: do not invent a verified project schema.
 * Create `.goose/` so doctor can label the host; MCP stays unwired until the
 * user runs the printed CLI / yaml themselves.
 */
export function writeGooseMarker(root: string): {
  action: McpWriteAction;
  path: string;
  addHint: string;
  yamlSnippet: string;
} {
  const dir = join(root, '.goose');
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  return {
    action: existed ? 'unchanged' : 'created',
    path: dir,
    addHint: gooseAddHint(),
    yamlSnippet: gooseYamlSnippet(),
  };
}

export function inspectGooseProject(root: string): McpInspection {
  const files = [join(root, 'goose.config.yaml'), join(root, '.goose', 'config.yaml')];
  for (const path of files) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (/envseal-mcp/.test(text)) {
      return {
        wired: true,
        status: 'wired',
        commandOk: null,
        message: `Goose config names envseal-mcp (${path}). [VERIFY]`,
      };
    }
  }

  return {
    wired: false,
    status: 'missing',
    commandOk: null,
    message:
      'Goose is not OOTB: run `goose mcp add` (see envseal init output) or merge the yaml snippet. envseal does not write ~/.config/goose/. [VERIFY]',
  };
}
