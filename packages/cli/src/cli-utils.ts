import { Broker } from '@envseal/core';
import { createStubPrompter } from './test-prompter.js';

/**
 * Create a broker for the given project root.
 * Uses the stub prompter if ENVSEAL_TEST_MODE and ENVSEAL_TEST_PROMPTER_VALUE are both set.
 */
export async function createBroker(root: string): Promise<Broker> {
  let prompter;

  // Double-gated stub prompter for testing only
  if (
    process.env.ENVSEAL_TEST_MODE === '1' &&
    process.env.ENVSEAL_TEST_PROMPTER_VALUE
  ) {
    prompter = createStubPrompter(process.env.ENVSEAL_TEST_PROMPTER_VALUE);
  }

  return new Broker({ root, prompter });
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
