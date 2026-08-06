import { INPUT_SCHEMAS } from '@envseal/protocol';
import type { Broker } from '@envseal/core';
import { respond, respondError } from '../respond.js';

export const name = 'env_use';

export const description =
  'Runs a command with the named secrets injected into the child environment only. ' +
  'Output is filtered so the values cannot appear in what you read back. ' +
  'Requires user confirmation. ' +
  'Pass the command as an argv array with no shell. ' +
  'It will NOT print the secrets to you, will NOT export them into your own environment, and refuses to ' +
  'run without explicit user confirmation. ' +
  'To check whether a key exists instead of running a command, call env_describe.';

export const inputSchema = INPUT_SCHEMAS.env_use;

export async function handler(args: unknown, broker: Broker) {
  try {
    const input = INPUT_SCHEMAS.env_use.parse(args ?? {});
    const result = await broker.use(input);
    return respond(result);
  } catch (error) {
    return respondError(error);
  }
}
