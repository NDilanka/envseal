import { createBroker, dispatch } from '@envseal/sdk';
import { StubPrompter } from './stub-prompter.js';
import type { ManifestEntry } from '@envseal/protocol';

interface ToolCall {
  tool: string;
  args: unknown;
}

interface ToolResult {
  toolCall: ToolCall;
  result: unknown;
}

/**
 * Runs a simplified agent loop that exercises the SDK.
 * Returns all tool calls and results in order so tests can check for leaked secrets.
 */
export async function runAgentLoop(): Promise<{
  toolResults: ToolResult[];
  allMessagesText: string;
}> {
  const broker = createBroker({
    root: process.cwd(),
    prompter: new StubPrompter(),
  });

  const toolResults: ToolResult[] = [];
  const toolCallSequence: ToolCall[] = [];

  // Step 1: Declare TEST_KEY
  const declareCall: ToolCall = {
    tool: 'env_declare',
    args: {
      entries: [
        {
          key: 'TEST_KEY',
          description: 'Test key for zero-leak validation',
          required: true,
          secret: true,
        } as ManifestEntry,
      ],
    },
  };

  const declareResult = await dispatch(broker, declareCall.tool, declareCall.args);
  toolResults.push({ toolCall: declareCall, result: declareResult });
  toolCallSequence.push(declareCall);

  // Step 2: Describe manifest (should show TEST_KEY is declared but not present)
  const describeCall1: ToolCall = {
    tool: 'env_describe',
    args: {},
  };

  const describeResult1 = await dispatch(
    broker,
    describeCall1.tool,
    describeCall1.args,
  );
  toolResults.push({ toolCall: describeCall1, result: describeResult1 });
  toolCallSequence.push(describeCall1);

  // Step 3: Request the key
  const requestCall: ToolCall = {
    tool: 'env_request',
    args: {
      keys: ['TEST_KEY'],
      reason: 'Testing SDK integration',
    },
  };

  const requestResult = await dispatch(broker, requestCall.tool, requestCall.args);
  toolResults.push({ toolCall: requestCall, result: requestResult });
  toolCallSequence.push(requestCall);

  // Extract ticket from result
  const ticket = (requestResult as any).ticket;
  if (!ticket) {
    throw new Error('env_request did not return a ticket');
  }

  // Step 4: Await the ticket (using stub prompter that immediately returns)
  const awaitCall: ToolCall = {
    tool: 'env_await',
    args: {
      ticket,
      timeoutMs: 5000,
    },
  };

  const awaitResult = await dispatch(broker, awaitCall.tool, awaitCall.args);
  toolResults.push({ toolCall: awaitCall, result: awaitResult });
  toolCallSequence.push(awaitCall);

  // Step 5: Describe again (should show TEST_KEY is now present with fingerprint)
  const describeCall2: ToolCall = {
    tool: 'env_describe',
    args: {},
  };

  const describeResult2 = await dispatch(
    broker,
    describeCall2.tool,
    describeCall2.args,
  );
  toolResults.push({ toolCall: describeCall2, result: describeResult2 });
  toolCallSequence.push(describeCall2);

  // Serialize all messages for leak testing
  const allMessagesText = JSON.stringify({
    toolCalls: toolCallSequence,
    results: toolResults,
  });

  return {
    toolResults,
    allMessagesText,
  };
}
