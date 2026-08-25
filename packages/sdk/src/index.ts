import { findProjectRoot } from '@envseal/core';
import { Broker, type BrokerOptions } from '@envseal/core';
import type { Prompter } from '@envseal/prompters';
import { selectPrompter } from '@envseal/prompters';
import {
  SEP_TOOL_NAMES,
  INPUT_SCHEMAS,
  isSepError,
} from '@envseal/protocol';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { annotateVerifyResults, createProbeApproval, createRevokeConfirm, createUseConfirm } from './confirm.js';

export interface CreateBrokerOptions {
  root?: string;
  prompter?: Prompter;
}

export function createBroker(opts?: CreateBrokerOptions): Broker {
  const root = opts?.root ?? findProjectRoot(process.cwd());

  // Resolved lazily and memoised: `selectPrompter()` is async and this factory
  // is not, and the surface is only needed if someone actually calls env_use or
  // trips a non-allowlisted probe. `selectPrompter` hands back process-wide
  // singletons, so this is the same instance the Broker resolves for
  // env_request value entry.
  let surfacePromise: Promise<Prompter> | null = null;
  const prompter = (): Promise<Prompter> => {
    const injected = opts?.prompter;
    surfacePromise ??= injected === undefined ? selectPrompter() : Promise.resolve(injected);
    return surfacePromise;
  };
  const surface = { projectRoot: root, prompter };

  const brokerOpts: BrokerOptions = {
    root,
    prompter: opts?.prompter,
    // Without these two the broker has no way to ask a human, and exec.ts
    // reports the absent callback as SEP_CONFIRMATION_DENIED — blaming a user
    // who was never asked. See confirm.ts.
    onConfirm: createUseConfirm(surface),
    onRevokeConfirm: createRevokeConfirm(surface),
    onApprovalNeeded: createProbeApproval(surface),
  };
  return new Broker(brokerOpts);
}

/** True for the seven SEP/1 tool names. Exported so a transport can 404 an unknown route. */
export function isSepToolName(name: string): name is keyof typeof INPUT_SCHEMAS {
  return Object.prototype.hasOwnProperty.call(INPUT_SCHEMAS, name);
}

export type Dialect = 'openai' | 'anthropic' | 'gemini';

const TOOL_DESCRIPTIONS: Record<(typeof SEP_TOOL_NAMES)[number], string> = {
  env_describe:
    'Returns only redacted status: whether each key is present, a length bucket, and a salted fingerprint. ' +
    'This never returns secret values and there is no flag, option, or debug mode that makes it do so. ' +
    'Do not attempt to read .env directly — that is blocked and unnecessary. ' +
    'Use this to see which declared keys exist, whether a value is present, and whether a stored value ' +
    'changed since your last call (compare fingerprints). ' +
    'It will NOT return, echo, or reconstruct any value. ' +
    'To collect a missing value, first call env_declare (if the key is not yet declared), then env_request.',

  env_declare:
    'Declares that this project needs the given environment variables by writing entries to the project ' +
    'manifest (env.schema.jsonc). Idempotent; does not prompt the user. ' +
    'Declare metadata only: key name, description, and optional format/provider constraints. ' +
    'It will NOT collect values and rejects any entry that tries to carry a value. ' +
    'After declaring, call env_describe to check presence or env_request to prompt the user for the value.',

  env_request:
    'Opens a secure input surface where the user types the value directly. You will never see the value. ' +
    'Returns a ticket immediately; poll env_await for the outcome. ' +
    'You must call env_declare for a key before you can request it. ' +
    "The 'reason' field is shown verbatim to the user, so write it as a clear, honest ask explaining why " +
    'the project needs the key. ' +
    'It will NOT return the value, and the typed value never crosses this channel — only a ticket that ' +
    'you poll with env_await.',

  env_await:
    'Blocks up to timeoutMs (default 90000, max 120000) for a pending env_request ticket to resolve, then ' +
    'returns per-key outcomes: stored, skipped, cancelled, invalid_format, verify_failed, or timeout. ' +
    'If the outcome is timeout, the prompt is still open — call env_await again with the same ticket. ' +
    'It will NOT return the value the user typed, only outcomes. ' +
    'To retry a failed request, call env_request again.',

  env_verify:
    'Tests a stored credential against its provider and returns a classified result. ' +
    "Never returns the provider's response body. " +
    'Results are classified as ok, auth_failed, forbidden, rate_limited, network_error, no_probe, or ' +
    'probe_not_approved, plus a short sanitized message. ' +
    'It will NOT return raw provider responses, headers, or the credential itself. ' +
    'To check mere presence rather than validity, call env_describe instead.',

  env_use:
    'Runs a command with the named secrets injected into the child environment only. ' +
    'Output is filtered so the values cannot appear in what you read back. ' +
    'Requires user confirmation. ' +
    'Pass the command as an argv array with no shell. ' +
    'It will NOT print the secrets to you, will NOT export them into your own environment, and refuses to ' +
    'run without explicit user confirmation. ' +
    'To check whether a key exists instead of running a command, call env_describe.',

  env_revoke:
    'Removes stored credentials after user confirmation. Records in the audit log and emits the provider ' +
    'rotation URL so you can help the user invalidate the old key.',
};

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: unknown;
}

interface GeminiTools {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: unknown;
  }>;
}

export function toolsFor(dialect: Dialect): unknown[] {
  const tools: OpenAITool[] | AnthropicTool[] | GeminiTools[] = [];

  for (const toolName of SEP_TOOL_NAMES) {
    const schema = INPUT_SCHEMAS[toolName];
    const jsonSchema = zodToJsonSchema(schema);

    const description = TOOL_DESCRIPTIONS[toolName];

    if (dialect === 'openai') {
      const parameters = {
        type: 'object' as const,
        ...jsonSchema,
      };
      (tools as OpenAITool[]).push({
        type: 'function',
        function: {
          name: toolName,
          description,
          parameters,
        },
      });
    } else if (dialect === 'anthropic') {
      (tools as AnthropicTool[]).push({
        name: toolName,
        description,
        input_schema: jsonSchema,
      });
    } else if (dialect === 'gemini') {
      if (tools.length === 0) {
        (tools as GeminiTools[]).push({
          functionDeclarations: [],
        });
      }
      const toolsObj = (tools as GeminiTools[])[0];
      if (toolsObj !== undefined) {
        toolsObj.functionDeclarations.push({
          name: toolName,
          description,
          parameters: jsonSchema,
        });
      }
    }
  }

  return tools;
}

export async function dispatch(
  broker: Broker,
  name: string,
  args: unknown,
): Promise<unknown> {
  // Narrow `name` to the tool-name union up front so the switch below can be
  // checked for exhaustiveness rather than falling through at runtime.
  if (!isSepToolName(name)) {
    return {
      error: {
        code: 'SEP_UNKNOWN_KEY',
        userMessage: `Unknown tool: ${name}`,
        retriable: false,
      },
    };
  }
  const schema = INPUT_SCHEMAS[name];

  if (!schema) {
    return {
      error: {
        code: 'SEP_UNKNOWN_KEY',
        userMessage: 'Unknown tool',
        retriable: false,
      },
    };
  }

  try {
    const validated = schema.parse(args);

    // Explicit table rather than `broker[name]`. The tool names are protocol
    // surface (`env_request`); the Broker's methods are not (`request`). Indexing
    // the broker by tool name therefore misses on six of the seven tools, and an
    // `as any` on that lookup turns the mismatch into a runtime "Tool not
    // available" instead of a compile error.
    switch (name) {
      case 'env_describe':
        // describe takes no arguments; the input schema exists only so callers
        // can pass an empty object without tripping validation.
        return await broker.describe();
      case 'env_declare':
        return await broker.declare(validated as Parameters<Broker['declare']>[0]);
      case 'env_request':
        return await broker.request(validated as Parameters<Broker['request']>[0]);
      case 'env_await':
        return await broker.await(validated as Parameters<Broker['await']>[0]);
      case 'env_verify':
        // `probe_not_approved` alone names a host and nothing the caller can
        // act on. See annotateVerifyResults.
        return annotateVerifyResults(
          await broker.verify(validated as Parameters<Broker['verify']>[0]),
        );
      case 'env_use':
        return await broker.use(validated as Parameters<Broker['use']>[0]);
      case 'env_revoke':
        return await broker.revoke(validated as Parameters<Broker['revoke']>[0]);
      default: {
        // Exhaustiveness: adding a tool without wiring it here is a build error.
        const unreachable: never = name;
        return {
          error: {
            code: 'SEP_UNKNOWN_KEY',
            userMessage: `Unknown tool: ${String(unreachable)}`,
            retriable: false,
          },
        };
      }
    }
  } catch (error) {
    if (isSepError(error)) {
      return {
        error: {
          code: error.code,
          userMessage: error.userMessage,
          retriable: error.retriable,
        },
      };
    }

    // Everything below is NOT a SepError, so its message is uncurated and may
    // embed a value or a filesystem path. W2 swept 22 HTTP exchanges and found
    // zero body leaks; surfacing `error.message` here is exactly how that
    // property would be lost. Zod is the concrete case: `invalid_enum_value`
    // quotes the value it received, which for a mis-typed argument is the
    // secret itself. So: report the real *kind* of failure, never its text.
    //
    // Detected structurally rather than with `instanceof ZodError` because zod
    // reaches this package only as a transitive dependency of @envseal/protocol.
    if (error instanceof Error && error.name === 'ZodError') {
      return {
        error: {
          code: 'SEP_FORMAT_INVALID',
          userMessage:
            `Arguments did not match the input schema for ${name}. Re-read that tool's inputSchema ` +
            'and call it again. The offending values are not echoed back because they may contain a secret.',
          retriable: true,
        },
      };
    }

    return {
      error: {
        code: 'SEP_INTERNAL',
        userMessage:
          'An internal error occurred. Details were suppressed because they may contain sensitive information.',
        retriable: false,
      },
    };
  }
}

export { SEP_TOOL_NAMES } from '@envseal/protocol';
export {
  createUseConfirm,
  createRevokeConfirm,
  createProbeApproval,
  annotateVerifyResults,
  CONFIRM_KEY_USE,
  CONFIRM_KEY_REVOKE,
  CONFIRM_KEY_PROBE,
} from './confirm.js';
export type { ConfirmSurface } from './confirm.js';
