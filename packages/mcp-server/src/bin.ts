#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Broker } from '@envseal/core';
import type { Prompter } from '@envseal/prompters';
import { selectPrompter } from '@envseal/prompters';
import { createServer } from './index.js';
import { parseArgv, resolveProjectRoot, USAGE, VERSION } from './cli-args.js';
import { createProbeApproval, createRevokeConfirm, createUseConfirm } from './confirm.js';
import {
  createRefusingPrompter,
  createStubPrompter,
  isStubOutcome,
} from './test-prompter.js';

// NOTE: MCP protocol owns stdout. All diagnostics MUST go to stderr.
// Any output to stdout corrupts the JSON-RPC stream.
//
// --help and --version are the two exceptions, and only because they exit
// before any transport is connected: at that point stdout is a terminal, not a
// JSON-RPC stream. Help nobody can see is the bug this replaced -- the old bin
// ignored --help entirely, wrote zero bytes to either stream, and left a
// .envseal/salt behind in whatever directory it happened to be launched from.

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));

  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`envseal-mcp ${VERSION}\n`);
    process.exit(0);
  }
  if (parsed.kind === 'usage-error') {
    process.stderr.write(`[envseal-mcp] Error: ${parsed.message}\n\n${USAGE}`);
    process.exit(2);
  }

  // Resolve BEFORE constructing anything: `new Broker` writes .envseal/salt.
  const resolved = resolveProjectRoot(parsed.project, process.cwd());
  if ('error' in resolved) {
    process.stderr.write(`[envseal-mcp] Error: ${resolved.error}\n`);
    process.exit(2);
  }
  const projectRoot = resolved.root;

  try {
    // Both gates must be set, and neither is ever set by the shipped CLI.
    // See the comment in test-prompter.ts for why this is deliberately awkward.
    const stubValue = process.env.ENVSEAL_TEST_PROMPTER_VALUE;
    const testMode = process.env.ENVSEAL_TEST_MODE === '1';
    // Same double gate and same precedence as the CLI's cli-utils.ts: a fixed
    // value wins, else a refusal outcome, else the real surface.
    const prompter: Prompter =
      testMode && stubValue !== undefined && stubValue !== ''
        ? createStubPrompter(stubValue)
        : testMode && isStubOutcome(process.env.ENVSEAL_TEST_PROMPTER_OUTCOME)
          ? createRefusingPrompter(process.env.ENVSEAL_TEST_PROMPTER_OUTCOME)
          : await selectPrompter();

    // One resolved surface for value entry AND for consent, so the user
    // approves a command on the same surface they type values into.
    const surface = { projectRoot, prompter: async (): Promise<Prompter> => prompter };
    const broker = new Broker({
      root: projectRoot,
      prompter,
      // env_use is advertised in tools/list. Without onConfirm the broker
      // cannot ask anyone, and exec.ts turns that absence into "the user
      // denied the confirmation" for a user who was never asked.
      onConfirm: createUseConfirm(surface),
      onRevokeConfirm: createRevokeConfirm(surface),
      // PLAN.md §6.4: consent before a credential goes to a host the registry
      // does not allowlist. Supplied by no binding before this.
      onApprovalNeeded: createProbeApproval(surface),
    });

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
