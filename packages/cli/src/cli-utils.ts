import { Broker } from '@envseal/core';
import type { TicketKeyOutcome, TicketOutcome } from '@envseal/protocol';
import { createStubPrompter, createRefusingPrompter, isStubOutcome } from './test-prompter.js';
import { registerDisposable } from './exit.js';

type BrokerOpts = ConstructorParameters<typeof Broker>[0];

/**
 * Create a broker for the given project root.
 * Uses the stub prompter if ENVSEAL_TEST_MODE and ENVSEAL_TEST_PROMPTER_VALUE are both set.
 *
 * The broker's `dispose()` is registered with the exit path here rather than
 * left to each command. No command called it before, so every invocation left
 * the ticket store's sweep interval running into `process.exit()`.
 */
export async function createBroker(
  root: string,
  opts?: {
    onConfirm?: BrokerOpts['onConfirm'];
    onApprovalNeeded?: BrokerOpts['onApprovalNeeded'];
  },
): Promise<Broker> {
  let prompter;

  // Double-gated stub prompters for testing only
  if (process.env.ENVSEAL_TEST_MODE === '1') {
    if (process.env.ENVSEAL_TEST_PROMPTER_VALUE) {
      prompter = createStubPrompter(process.env.ENVSEAL_TEST_PROMPTER_VALUE);
    } else if (isStubOutcome(process.env.ENVSEAL_TEST_PROMPTER_OUTCOME)) {
      prompter = createRefusingPrompter(process.env.ENVSEAL_TEST_PROMPTER_OUTCOME);
    }
  }

  const broker = new Broker({
    root,
    prompter,
    onConfirm: opts?.onConfirm,
    onApprovalNeeded: opts?.onApprovalNeeded,
  });
  registerDisposable(() => broker.dispose());
  return broker;
}

/**
 * Whether there is a human we could put a question to.
 *
 * `CI` is checked as well as the TTY because a CI runner can attach a pseudo
 * terminal while there is still nobody watching it; `selectPrompter` already
 * treats `CI` as decisive, and disagreeing with it here would mean the probe
 * approval prompt blocks a build that `env_request` correctly refuses.
 */
export function hasInteractiveSurface(): boolean {
  if (process.env.CI !== undefined) return false;
  return process.stdin.isTTY === true;
}

/**
 * The recorded outcome for `key`, or one derived from the ticket state when the
 * prompt surface never produced one.
 *
 * A ticket that expires or is torn down leaves `keys` empty. `set` used to
 * throw a bare `Error('No outcome returned')` there, which reported a timeout
 * as a generic internal failure and lost the documented exit code. Returns null
 * only for the genuinely inconsistent case: the ticket resolved, yet said
 * nothing about this key.
 */
export function outcomeForKey(
  result: TicketOutcome,
  key: string,
): TicketKeyOutcome | null {
  const recorded = result.keys.find((k) => k.key === key);
  if (recorded) return recorded.outcome;

  switch (result.state) {
    case 'expired':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
      // `await` returned while still pending: its own timeout fired first.
      return 'timeout';
    case 'resolved':
      return null;
    default: {
      const _exhaustive: never = result.state;
      return _exhaustive;
    }
  }
}

/**
 * The only flags that consume the following token as their value — exactly the
 * ones bin.ts reads with `as string` (`--project`, `--host`). Every other
 * `--flag` is boolean.
 *
 * Without this table the parser treated ANY token after a bare flag as that
 * flag's value, so `envseal status --json OPENAI_API_KEY` silently parsed as
 * `status` with neither `--json` nor the key filter: flags.json became the
 * STRING 'OPENAI_API_KEY' (so `flags.json === true` was false) and the key name
 * never reached `args`. Plain-text status for all keys, exit 0.
 */
const VALUE_FLAGS = new Set(['project', 'host']);

/**
 * Parse command-line arguments, extracting flags and positional args.
 */
export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  args: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;

    // `--` is the end-of-flags terminator, not a flag. It must be checked
    // before the `startsWith('--')` branch, which would otherwise parse it as a
    // flag named '' and swallow the command that follows — breaking
    // `envseal run -- <cmd>` entirely.
    if (arg === '--') {
      args.push('--');
      for (let j = i + 1; j < argv.length; j++) {
        const a = argv[j];
        if (a !== undefined) args.push(a);
      }
      break;
    }

    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex > -1) {
        const key = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        flags[key] = value;
      } else {
        const key = arg.slice(2);
        const nextArg = argv[i + 1];
        // Only a known value-taking flag may swallow the next token. A bare
        // boolean flag (`--json`) must leave it for the positional loop below,
        // so `status --json KEY` and the documented `status KEY --json` parse
        // identically.
        if (VALUE_FLAGS.has(key) && nextArg !== undefined && !nextArg.startsWith('--')) {
          flags[key] = nextArg;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg === '-') {
      // End of flags, rest are positional
      for (let j = i + 1; j < argv.length; j++) {
        const a = argv[j];
        if (a !== undefined) {
          args.push(a);
        }
      }
      break;
    } else if (arg === '-h') {
      // A help request is a control token, not data. Left in args, it made
      // `envseal ensure -h` run the real command with '-h' as a stray
      // positional; bin.ts reads flags.help and prints usage instead.
      flags.help = true;
    } else {
      args.push(arg);
    }
    i++;
  }

  return { flags, args };
}

/**
 * Per-subcommand usage, shown when -h/--help appears anywhere before the `--`
 * terminator. Text mirrors docs/cli-contract.md; every block opens with the
 * word "Usage" so a caller can assert that help was shown rather than a command
 * having run.
 */
const COMMAND_USAGE: Record<string, string> = {
  init: `Usage: envseal init [--host <name>] [--json] [--project <path>]

Initialize env.schema.jsonc, declaring every environment-variable reference found by scanning the project.

  --host <name>     Override host detection. Valid values: claude-code, cursor, continue, aider, generic, unknown.
  --json            Output as JSON.
  --project <path>  Project root (default: auto-detect).`,
  ensure: `Usage: envseal ensure [--json] [--project <path>]

Prompt for every missing required key in one pass.

  --json            Output as JSON.
  --project <path>  Project root (default: auto-detect).`,
  set: `Usage: envseal set <KEY> [--json] [--project <path>]

Prompt for a single key and store it in the entry's declared sink.

  --json            Output as JSON.
  --project <path>  Project root (default: auto-detect).`,
  status: `Usage: envseal status [KEY...] [--json] [--project <path>]

Show which declared keys are present. Never prints values.

  --json            Output as JSON.
  --project <path>  Project root (default: auto-detect).`,
  verify: `Usage: envseal verify [KEY...] [--json] [--project <path>]

Run verification probes and report a classified result per key.

  --json            Output as JSON.
  --project <path>  Project root (default: auto-detect).`,
  run: `Usage: envseal run [--yes] [--json] [--project <path>] -- <cmd...>

Execute a command with secrets injected into the child environment only.
Asks for confirmation first; --yes (or ENVSEAL_ASSUME_YES=1) pre-approves it.

  --yes             Skip the confirmation prompt.
  --json            Output exit code and redacted stdout/stderr as JSON.
  --project <path>  Project root (default: auto-detect).`,
  doctor: `Usage: envseal doctor [--json] [--project <path>]

Audit the project configuration: detected host and tier, gitignore coverage,
file permissions, missing required keys.

  --json            Output as JSON.
  --project <path>  Project root (default: auto-detect).`,
  revoke: `Usage: envseal revoke <KEY> [--json] [--project <path>]

Remove a key from its sink and report the provider's rotation URL.

  --json            Output as JSON.
  --project <path>  Project root (default: auto-detect).`,
  mcp: `Usage: envseal mcp

Start the MCP server over stdio. The host launches this itself; do not run it directly.`,
};

/**
 * The usage block for `command`, or null when the command is not one envseal
 * knows — an unknown command keeps its unknown-command treatment in bin.ts.
 */
export function commandUsage(command: string | undefined): string | null {
  if (command === undefined) return null;
  return COMMAND_USAGE[command] ?? null;
}
