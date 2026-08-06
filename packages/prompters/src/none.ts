import { SepError } from '@envseal/protocol';
import type { Prompter, PromptRequest, PromptResponse } from './types.js';

/**
 * CI surface: fails fast and machine-readably. MUST NOT hang, MUST NOT prompt,
 * MUST NOT fall back to asking in chat.
 */
export class NonePrompter implements Prompter {
  readonly id: 'none' = 'none';

  async available(): Promise<boolean> {
    return true;
  }

  async cancel(_ticket: string): Promise<void> {
    // Nothing is ever shown; there is nothing to cancel.
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    throw new SepError({
      code: 'SEP_NO_INTERACTIVE_SURFACE',
      userMessage: `No interactive surface available for keys: ${req.keys
        .map((k) => k.key)
        .join(', ')}. Configure them out-of-band for CI.`,
    });
  }
}