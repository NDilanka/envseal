#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Broker } from '@envseal/core';
import { findProjectRoot } from '@envseal/core';
import { selectPrompter } from '@envseal/prompters';
import { createServer } from './index.js';
import { createStubPrompter } from './test-prompter.js';

// NOTE: MCP protocol owns stdout. All diagnostics MUST go to stderr.
// Any output to stdout corrupts the JSON-RPC stream.

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let projectRoot: string = findProjectRoot(process.cwd());
  let isHttp = false;
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project' && i + 1 < args.length) {
      const nextArg = args[i + 1];
      if (typeof nextArg === 'string') {
        projectRoot = nextArg;
      }
      i++;
    } else if (arg === '--http') {
      isHttp = true;
    } else if (arg === '--port' && i + 1 < args.length) {
      const nextArg = args[i + 1];
      if (typeof nextArg === 'string') {
        const parsed = parseInt(nextArg, 10);
        if (!Number.isNaN(parsed)) {
          port = parsed;
        }
      }
      i++;
    }
  }

  try {
    // Both gates must be set, and neither is ever set by the shipped CLI.
    // See the comment in test-prompter.ts for why this is deliberately awkward.
    const stubValue = process.env.ENVSEAL_TEST_PROMPTER_VALUE;
    const testMode = process.env.ENVSEAL_TEST_MODE === '1';
    const prompter =
      testMode && stubValue !== undefined && stubValue !== ''
        ? createStubPrompter(stubValue)
        : await selectPrompter();
    const broker = new Broker({ root: projectRoot, prompter });

    const mcpServer = createServer(broker);
    const transport = new StdioServerTransport();

    await mcpServer.connect(transport);

    // Keep the server running
    await new Promise<void>(() => {
      // This promise never resolves, keeping the process alive
    });
  } catch (error) {
    // Log to stderr only
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[envseal-mcp] Error: ${message}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);
  console.error(`[envseal-mcp] Fatal error: ${message}`);
  process.exit(1);
});
