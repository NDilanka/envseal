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
    id: 'none',
    available: async () => true,
    prompt: async (req: PromptRequest): Promise<PromptResponse> => ({
      ticket: req.ticket,
      results: req.keys.map((k) => ({
        key: k.key,
        outcome: 'entered' as const,
        value: secretFromUtf8(value),
      })),
    }),
    cancel: async () => {
      /* nothing to tear down */
    },
  };
}
