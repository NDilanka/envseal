import { INPUT_SCHEMAS } from '@envseal/protocol';
import type { Broker } from '@envseal/core';
import { respond, respondError } from '../respond.js';

export const name = 'env_await';

export const description =
  'Blocks up to timeoutMs (default 90000, max 120000) for a pending env_request ticket to resolve, then ' +
  'returns per-key outcomes: stored, skipped, cancelled, invalid_format, verify_failed, or timeout. ' +
  'If the outcome is timeout, the prompt is still open — call env_await again with the same ticket. ' +
  'It will NOT return the value the user typed, only outcomes. ' +
  'To retry a failed request, call env_request again.';

export const inputSchema = INPUT_SCHEMAS.env_await;

export async function handler(args: unknown, broker: Broker) {
  try {
    const input = INPUT_SCHEMAS.env_await.parse(args ?? {});
    const result = await broker.await(input);
    return respond(result);
  } catch (error) {
    return respondError(error);
  }
}
