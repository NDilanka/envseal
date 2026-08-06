import { isSepError } from '@envseal/protocol';
import { redact } from '@envseal/core';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  isError?: true;
  // The MCP SDK's CallToolResult carries an open index signature. Declaring it
  // here lets handlers satisfy that type without a cast at the registration
  // site — the original `as never` casts there are what allowed a server that
  // could not start to pass typecheck.
  [key: string]: unknown;
}

/**
 * THE SINGLE EGRESS POINT. Every tool handler returns exclusively through
 * `respond` or `respondError`; nothing in `src/tools/` may construct a
 * response object itself. Every string that leaves the server toward the
 * model passes through the core redactor here. The secret set is empty at
 * this layer by construction: the broker never hands a secret value to a
 * tool handler, so there is nothing to redact-against-and-reveal here. Any
 * string that touched a live value (e.g. `env_use` child output) is already
 * redacted by the broker before it reaches this point.
 */
export function respond(payload: unknown): ToolResult {
  return { content: asContent(JSON.stringify(payload)) };
}

export function respondError(error: unknown): ToolResult {
  if (isSepError(error)) {
    // SepError messages are curated, user-facing strings from the protocol —
    // never raw internals, stack traces, or provider responses.
    return {
      content: asContent(
        JSON.stringify({
          code: error.code,
          userMessage: error.userMessage,
          retriable: error.retriable,
        }),
      ),
      isError: true,
    };
  }
  // Unknown error: NEVER surface the raw message or stack trace — it may
  // embed a credential or a partial value. Send a fixed safe message instead.
  return {
    content: asContent(
      JSON.stringify({
        code: 'SEP_INTERNAL',
        userMessage:
          'An internal error occurred. Details were suppressed because they may contain sensitive information.',
        retriable: false,
      }),
    ),
    isError: true,
  };
}

function asContent(text: string): TextContent[] {
  const filtered = redact(text, []);
  return [{ type: 'text', text: filtered.text }];
}
