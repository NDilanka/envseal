import { Buffer } from 'node:buffer';
import type { Prompter, PromptRequest, PromptResponse } from '@envseal/prompters';
import { asSecret } from '@envseal/protocol';

export class StubPrompter implements Prompter {
  readonly id = 'stub';

  async available(): Promise<boolean> {
    return true;
  }

  async prompt(_req: PromptRequest): Promise<PromptResponse> {
    // Return a fixed sentinel value for testing that it doesn't leak
    const sentinelValue = 'sk-SENTINEL-SDK-DO-NOT-LEAK-4f5a6b7c8d9e';
    return {
      keys: _req.keys.map((key) => ({
        key,
        value: asSecret(Buffer.from(sentinelValue, 'utf8')),
      })),
    };
  }

  async cancel(): Promise<void> {
    // noop
  }
}
