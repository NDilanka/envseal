import type { Broker } from '@envseal/core';
import { EnvRevokeInput, INPUT_SCHEMAS } from '@envseal/protocol';
import { respond, respondError } from '../respond.js';

export const name = 'env_revoke';

export const description =
  'Removes stored credentials. Records in the audit log and emits the provider rotation URL so you can help the user invalidate the old key.';

export const inputSchema = INPUT_SCHEMAS.env_revoke;

export async function handler(args: unknown, broker: Broker) {
  try {
    const input = EnvRevokeInput.parse(args);
    const result = await broker.revoke(input);
    return respond(result);
  } catch (error) {
    return respondError(error);
  }
}
