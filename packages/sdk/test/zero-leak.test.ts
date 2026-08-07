import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker, dispatch } from '../src/index.js';
import { secretFromUtf8 } from '@envseal/protocol';
import type { Prompter, PromptRequest, PromptResponse } from '@envseal/prompters';

const SENTINEL = 'sk-SENTINEL-SDK-DO-NOT-LEAK-4f5a6b7c8d9e';

describe('zero-leak', () => {
  let root: string;

  beforeEach(() => {
    // Must be a throwaway directory, NOT process.cwd(). Pointing the broker at
    // the repo makes the test write a manifest and a .env into the source tree.
    root = mkdtempSync(join(tmpdir(), 'envseal-sdk-zeroleak-'));
    // The dotenv sink refuses to write where .gitignore does not cover .env.
    writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sentinel value does not leak through dispatch results', async () => {
    // Must match the Prompter contract exactly: `results`, each carrying an
    // `outcome`. Returning `{ keys: [...] }` leaves the broker with no entered
    // values, so the ticket resolves as `cancelled` and the flow never runs.
    const stub: Prompter = {
      id: 'ide',
      available: async () => true,
      prompt: async (req: PromptRequest): Promise<PromptResponse> => ({
        ticket: req.ticket,
        results: req.keys.map((k) => ({
          key: k.key,
          outcome: 'entered' as const,
          value: secretFromUtf8(SENTINEL),
        })),
      }),
      cancel: async () => {},
    };

    const broker = createBroker({ root, prompter: stub });

    // Run flow: declare -> describe -> request -> await -> describe
    const sentinel = SENTINEL;
    const allMessages: string[] = [];

    // Step 1: declare
    const declareResult = await dispatch(broker, 'env_declare', {
      entries: [
        {
          key: 'TEST_KEY',
          description: 'Test key',
          required: true,
          secret: true,
        },
      ],
    });
    allMessages.push(JSON.stringify(declareResult));

    // Step 2: describe (before request)
    const describeResult1 = await dispatch(broker, 'env_describe', {});
    allMessages.push(JSON.stringify(describeResult1));

    // Step 3: request
    const requestResult = await dispatch(broker, 'env_request', {
      keys: ['TEST_KEY'],
      reason: 'Testing SDK',
    });
    allMessages.push(JSON.stringify(requestResult));
    const ticket = (requestResult as any).ticket;
    // Unconditional. Guarding the rest of the flow on `ticket` means a broken
    // env_request silently reduces this test to "a secret that was never
    // collected did not leak", which passes for free.
    expect(ticket, `env_request returned no ticket: ${JSON.stringify(requestResult)}`).toBeTruthy();

    // Step 4: await
    const awaitResult = await dispatch(broker, 'env_await', {
      ticket,
      timeoutMs: 5000,
    });
    allMessages.push(JSON.stringify(awaitResult));
    expect(JSON.stringify(awaitResult)).toContain('stored');

    // Step 5: describe again — the key must now be present
    const describeResult2 = await dispatch(broker, 'env_describe', {});
    allMessages.push(JSON.stringify(describeResult2));

    // Primary assertion: sentinel value must not leak
    const combinedMessages = allMessages.join('');
    expect(combinedMessages).not.toContain(sentinel);

    // Secondary assertion: at least one response contains fingerprint data
    // (proves the broker processed the flow, not vacuous)
    let hasFingerprint = false;
    for (const msg of allMessages) {
      if (msg.includes('fp_')) {
        hasFingerprint = true;
        break;
      }
    }

    // The value really did reach the sink, so "sentinel absent" above is a
    // statement about a secret that was actually collected.
    expect(hasFingerprint).toBe(true);
  });
});
