#!/usr/bin/env node

import { findProjectRoot } from '@envseal/core';
import { EXIT } from './exit-codes.js';
import { fail } from './output.js';
import { finish } from './exit.js';
import { parseArgs, commandUsage } from './cli-utils.js';
import { status } from './commands/status.js';
import { ensure } from './commands/ensure.js';
import { set } from './commands/set.js';
import { verify } from './commands/verify.js';
import { run } from './commands/run.js';
import { doctor } from './commands/doctor.js';
import { revoke } from './commands/revoke.js';
import { mcp } from './commands/mcp.js';
import { init } from './commands/init.js';

const VERSION = '0.1.4';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    showHelp();
    finish(EXIT.OK);
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(`envseal version ${VERSION}`);
    finish(EXIT.OK);
    return;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  // Parse global flags
  const parsed = parseArgs(rest);

  // A help request anywhere before the `--` terminator describes the
  // subcommand and exits 0 without executing it. Before this check,
  // `envseal ensure -h` ran the real command (exit 4 under CI) and an
  // interactive `set --help` reached the live browser prompt — a question
  // about the tool answered with side effects.
  if (parsed.flags.help === true) {
    const usage = commandUsage(command);
    if (usage !== null) {
      console.log(usage);
      finish(EXIT.OK);
      return;
    }
    // An unknown command asking for help keeps its existing treatment below:
    // the unknown-command error plus top-level help, exiting 2.
  }

  const json = parsed.flags.json === true;
  const projectFlag = parsed.flags.project as string | undefined;

  // Determine project root
  let root: string;
  try {
    root = projectFlag || findProjectRoot(process.cwd());
  } catch {
    root = process.cwd();
  }

  try {
    switch (command) {
      case 'init': {
        const host = parsed.flags.host as string | undefined;
        await init(root, json, host);
        break;
      }

      case 'ensure': {
        await ensure(root, json, parsed.flags.check === true);
        break;
      }

      case 'set': {
        const key = parsed.args[0];
        if (!key) {
          console.error('Error: set requires a KEY argument');
          finish(EXIT.USAGE);
          break;
        }
        await set(root, key, json);
        break;
      }

      case 'status': {
        const keys = parsed.args;
        await status(root, keys, json);
        break;
      }

      case 'verify': {
        const keys = parsed.args;
        await verify(root, keys, json);
        break;
      }

      case 'run': {
        if (parsed.args.length === 0 || parsed.args[0] !== '--') {
          console.error('Error: run requires -- followed by command');
          finish(EXIT.USAGE);
          break;
        }
        const cmdArgs = parsed.args.slice(1);
        if (cmdArgs.length === 0) {
          console.error('Error: run requires a command after --');
          finish(EXIT.USAGE);
          break;
        }
        await run(root, cmdArgs, json, parsed.flags.yes === true);
        break;
      }

      case 'doctor': {
        await doctor(root, json);
        break;
      }

      case 'revoke': {
        const key = parsed.args[0];
        if (!key) {
          console.error('Error: revoke requires a KEY argument');
          finish(EXIT.USAGE);
          break;
        }
        await revoke(root, key, json, parsed.flags.yes === true);
        break;
      }

      case 'mcp': {
        await mcp(root);
        break;
      }

      default: {
        console.error(`Error: unknown command '${command}'`);
        showHelp();
        finish(EXIT.USAGE);
        break;
      }
    }
  } catch (error) {
    fail(json, error);
  }
}

function showHelp(): void {
  console.log(`envseal ${VERSION}

Usage: envseal <command> [options]

Commands:
  init [--host <name>]          Initialize env.schema.jsonc
  ensure [--check]             Prompt for all missing required keys
                               (--check: report only, exit 0/1, never prompt)
  set <KEY>                     Prompt for a single key
  status [KEYS...]              Show status of keys
  verify [KEYS...]              Run verification probes
  run -- <cmd...>               Execute command with injected secrets
  doctor                        Report project configuration status
  revoke <KEY>                  Revoke a key from the sink
  mcp                           Start the MCP server

Global Options:
  --project <path>              Project root (default: auto-detect)
  --json                        Output as JSON
  --help, -h                    Show this help
  --version, -v                 Show version
`);
}

main().catch((error) => {
  fail(false, error);
});
