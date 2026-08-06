import { INPUT_SCHEMAS } from '@envseal/protocol';
import type { Broker } from '@envseal/core';
import { respond, respondError } from '../respond.js';

export const name = 'env_declare';

export const description =
  'Declares that this project needs the given environment variables by writing entries to the project ' +
  'manifest (env.schema.jsonc). Idempotent; does not prompt the user. ' +
  'Declare metadata only: key name, description, and optional format/provider constraints. ' +
  'It will NOT collect values and rejects any entry that tries to carry a value. ' +
  'After declaring, call env_describe to check presence or env_request to prompt the user for the value.';

export const inputSchema = INPUT_SCHEMAS.env_declare;

export async function handler(args: unknown, broker: Broker) {
  try {
    const input = INPUT_SCHEMAS.env_declare.parse(args ?? {});
    const result = await broker.declare(input);
    return respond(result);
  } catch (error) {
    return respondError(error);
  }
}
