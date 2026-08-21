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
        if (nextArg !== undefined && !nextArg.startsWith('--')) {
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
    } else {
      args.push(arg);
    }
    i++;
  }

  return { flags, args };
}
