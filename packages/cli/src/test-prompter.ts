import { secretFromUtf8 } from '@envseal/protocol';
import type { Prompter, PromptRequest, PromptResponse } from '@envseal/prompters';

/**
 * A prompter that returns a fixed value without any UI.
 *
 * This exists so the zero-leak test can drive the real server, over real stdio,
 * without a human at a browser. It is a deliberate hole in the "a value only ever
 * comes from the user" guarantee, so it is gated twice in `bin.ts`: the caller must
 * set BOTH `ENVSEAL_TEST_MODE=1` and `ENVSEAL_TEST_PROMPTER_VALUE`. Neither is ever
 * set by the shipped CLI, and nothing in the published package sets them for you.
 *
 * If you are reading this because you want to inject a value programmatically in
 * production: don't. Use a sink the value already lives in (keychain, vault) and let
 * `presence` resolve it. Injecting through the prompter path would put the value in
 * an environment variable, which is exactly what threat T6 is about.
 */
export function createStubPrompter(value: string): Prompter {
  return {
    id: 'ide',
    available: async () => true,
    prompt: async (req: PromptRequest): Promise<PromptResponse> => {
      // Announce the stub on stderr, mirroring probe-approval.ts's
      // ENVSEAL_TEST_APPROVAL notice: any answer that did not come from a
      // human must be visible in the transcript. A model that discovers the
      // two-variable gate cannot use it as a silent approval oracle.
      process.stderr.write(
        `ENVSEAL_TEST_MODE: prompter is a STUB — key(s) [${req.keys.map((k) => k.key).join(', ')}] ` +
          `answered from ENVSEAL_TEST_PROMPTER_VALUE with no UI.\n`,
      );
      return {
        ticket: req.ticket,
        results: req.keys.map((k) => ({
          key: k.key,
          outcome: 'entered' as const,
          value: secretFromUtf8(value),
        })),
      };
    },
    cancel: async () => {
      /* nothing to tear down */
    },
  };
}

/** Non-`entered` outcomes a stub prompter can be told to report. */
export type StubOutcome = 'skipped' | 'cancelled' | 'timeout';

export function isStubOutcome(value: string | undefined): value is StubOutcome {
  return value === 'skipped' || value === 'cancelled' || value === 'timeout';
}

/**
 * A prompter that reports a refusal without any UI.
 *
 * The documented exit codes for `set` and `ensure` fork on WHY a key was not
 * stored, and until this existed there was no way to drive `cancelled` or
 * `timeout` through the real binary — so those rows of docs/cli-contract.md
 * were asserted by nothing.
 *
 * Gated the same way as createStubPrompter (`ENVSEAL_TEST_MODE=1` plus a second
 * variable), but note it is strictly the safer of the two: it can only ever
 * make the CLI report that nothing was stored. It cannot introduce a value.
 */
export function createRefusingPrompter(outcome: StubOutcome): Prompter {
  return {
    id: 'ide',
    available: async () => true,
    prompt: async (req: PromptRequest): Promise<PromptResponse> => ({
      ticket: req.ticket,
      results: req.keys.map((k) => ({ key: k.key, outcome })),
    }),
    cancel: async () => {
      /* nothing to tear down */
    },
  };
}
