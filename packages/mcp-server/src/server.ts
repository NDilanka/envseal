import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { SepError } from '@envseal/protocol';
import type { Broker } from '@envseal/core';

import * as describe from './tools/describe.js';
import * as declare from './tools/declare.js';
import * as request from './tools/request.js';
import * as await_ from './tools/await.js';
import * as verify from './tools/verify.js';
import * as use from './tools/use.js';
import * as revoke from './tools/revoke.js';
import { respondError } from './respond.js';

const toolModules = [describe, declare, request, await_, verify, use, revoke];

export function createServer(broker: Broker): Server {
  // Capabilities must be declared up front or a client will never issue
  // tools/list, and the handlers below would be dead code.
  const server = new Server(
    { name: 'envseal-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolModules.map((mod) => ({
      name: mod.name,
      description: mod.description,
      inputSchema: zodToJsonSchema(mod.inputSchema) as Record<string, unknown>,
    })),
  }));

  // The SDK's result type is a union that also covers long-running "task"
  // responses; annotating pins it to the plain content form these tools return.
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const toolName = req.params.name;
    const toolModule = toolModules.find((mod) => mod.name === toolName);
    if (toolModule === undefined) {
      // Routed through the single egress helper like every other result, so
      // there is exactly one place where an outbound string is built.
      return respondError(
        new SepError({
          code: 'SEP_UNKNOWN_KEY',
          userMessage: `Unknown tool: ${toolName}`,
        }),
      );
    }
    return await toolModule.handler(req.params.arguments, broker);
  });

  return server;
}

export { describe, declare, request, await_, verify, use, revoke };
