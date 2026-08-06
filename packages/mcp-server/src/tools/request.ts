import { INPUT_SCHEMAS } from '@envseal/protocol';
import type { Broker } from '@envseal/core';
import { respond, respondError } from '../respond.js';

export const name = 'env_request';

export const description =
  'Opens a secure input surface where the user types the value directly. You will never see the value. ' +
  'Returns a ticket immediately; poll env_await for the outcome. ' +
  'You must call env_declare for a key before you can request it. ' +
  "The 'reason' field is shown verbatim to the user, so write it as a clear, honest ask explaining why " +
  'the project needs the key. ' +
  'It will NOT return the value, and the typed value never crosses this channel — only a ticket that ' +
  'you poll with env_await.';

export const inputSchema = INPUT_SCHEMAS.env_request;

export async function handler(args: unknown, broker: Broker) {
  try {
    const input = INPUT_SCHEMAS.env_request.parse(args ?? {});
    const result = await broker.request(input);
    return respond(result);
  } catch (error) {
    return respondError(error);
  }
}
