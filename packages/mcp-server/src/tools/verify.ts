import { INPUT_SCHEMAS } from '@envseal/protocol';
import type { Broker } from '@envseal/core';
import { respond, respondError } from '../respond.js';
import { annotateVerifyResults } from '../confirm.js';

export const name = 'env_verify';

export const description =
  'Tests a stored credential against its provider and returns a classified result. ' +
  'Never returns the provider\'s response body. ' +
  'Results are classified as ok, auth_failed, forbidden, rate_limited, network_error, no_probe, or ' +
  'probe_not_approved, plus a short sanitized message. ' +
  'It will NOT return raw provider responses, headers, or the credential itself. ' +
  'To check mere presence rather than validity, call env_describe instead.';

export const inputSchema = INPUT_SCHEMAS.env_verify;

export async function handler(args: unknown, broker: Broker) {
  try {
    const input = INPUT_SCHEMAS.env_verify.parse(args ?? {});
    // `probe_not_approved` alone names a host and nothing the caller can act
    // on. See annotateVerifyResults.
    const result = annotateVerifyResults(await broker.verify(input));
    return respond(result);
  } catch (error) {
    return respondError(error);
  }
}
