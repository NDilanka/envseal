import { INPUT_SCHEMAS } from '@envseal/protocol';
import type { Broker } from '@envseal/core';
import { respond, respondError } from '../respond.js';

export const name = 'env_describe';

export const description =
  'Returns only redacted status: whether each key is present, a length bucket, and a salted fingerprint. ' +
  'This never returns secret values and there is no flag, option, or debug mode that makes it do so. ' +
  'Do not attempt to read .env directly — that is blocked and unnecessary. ' +
  'Use this to see which declared keys exist, whether a value is present, and whether a stored value ' +
  'changed since your last call (compare fingerprints). ' +
  'It will NOT return, echo, or reconstruct any value. ' +
  'To collect a missing value, first call env_declare (if the key is not yet declared), then env_request.';

export const inputSchema = INPUT_SCHEMAS.env_describe;

export async function handler(args: unknown, broker: Broker) {
  try {
    const input = INPUT_SCHEMAS.env_describe.parse(args ?? {});
    const result = await broker.describe();
    return respond(result);
  } catch (error) {
    return respondError(error);
  }
}
