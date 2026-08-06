import { describe, it, expect } from 'vitest';
import { SepError } from '@envseal/protocol';
import { NonePrompter } from '../src/none.js';
import type { PromptRequest } from '../src/types.js';

const none = new NonePrompter();

function request(overrides: Partial<PromptRequest> = {}): PromptRequest {
  return {
    ticket: 'tkt_test',
    nonce: '7F2A-91C4',
    projectRoot: '/repo',
    reason: 'needed for tests',
    keys: [{ key: 'OPENAI_API_KEY', description: 'OpenAI API key' }],
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe('none prompter', () => {
  it('is always available', async () => {
    expect(await none.available()).toBe(true);
  });

  it('throws SEP_NO_INTERACTIVE_SURFACE instead of hanging', async () => {
    const started = Date.now();
    const error = await none
      .prompt(request())
      .then(
        () => {
          throw new Error('expected prompt() to reject');
        },
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(SepError);
    expect((error as SepError).code).toBe('SEP_NO_INTERACTIVE_SURFACE');
    // Rejects immediately; it must never wait out the request timeout.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('lists the missing keys in the user message', async () => {
    const error = await none.prompt(
      request({ keys: [
        { key: 'OPENAI_API_KEY', description: 'a' },
        { key: 'DATABASE_URL', description: 'b' },
      ] }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as SepError).userMessage).toContain('OPENAI_API_KEY');
    expect((error as SepError).userMessage).toContain('DATABASE_URL');
  });
});