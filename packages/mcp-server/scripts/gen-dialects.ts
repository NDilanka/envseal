import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';


import * as describe from '../src/tools/describe.js';
import * as declare from '../src/tools/declare.js';
import * as request from '../src/tools/request.js';
import * as await_ from '../src/tools/await.js';
import * as verify from '../src/tools/verify.js';
import * as use from '../src/tools/use.js';
import * as revoke from '../src/tools/revoke.js';

const toolModules = [describe, declare, request, await_, verify, use, revoke];

interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function getToolInfos(): ToolInfo[] {
  return toolModules.map((mod) => ({
    name: mod.name,
    description: mod.description,
    inputSchema: zodToJsonSchema(mod.inputSchema) as Record<string, unknown>,
  }));
}

function writeJsonFile(path: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  writeFileSync(path, json + '\n', 'utf-8');
}

function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

async function main() {
  // Resolve to repository root: scripts/gen-dialects.ts -> packages/mcp-server/scripts -> packages/mcp-server -> packages -> repo-root
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '../../../');

  const dialectDir = resolve(repoRoot, 'spec/sep-1/dialects');
  mkdirSync(dialectDir, { recursive: true });

  const tools = getToolInfos();

  // MCP format
  const mcpTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  writeJsonFile(resolve(dialectDir, 'mcp.tools.json'), mcpTools);

  // OpenAI format
  const openaiTools = tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
  writeJsonFile(
    resolve(dialectDir, 'openai.tools.json'),
    sortObjectKeys(openaiTools)
  );

  // Anthropic format
  const anthropicTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  writeJsonFile(
    resolve(dialectDir, 'anthropic.tools.json'),
    sortObjectKeys(anthropicTools)
  );

  // Gemini format
  const geminiTools = {
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  };
  writeJsonFile(
    resolve(dialectDir, 'gemini.tools.json'),
    sortObjectKeys(geminiTools)
  );

  console.error('[gen-dialects] Generated tool dialects successfully');
}

main().catch((error) => {
  console.error('[gen-dialects] Error:', error);
  process.exit(1);
});
