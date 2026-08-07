import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBroker, dispatch } from '../src/index.js';
import { Broker } from '@envseal/core';

describe('dispatch', () => {
  let broker: Broker;

  // Use a stub prompter that throws immediately to avoid interactive prompts
  class StubPrompter {
    readonly id = 'stub';
    async available() {
      return true;
    }
    async prompt() {
      throw new Error('Stub prompter does not actually prompt');
    }
    async cancel() {}
  }

  let root: string;

  beforeEach(() => {
    // Must be a throwaway directory, NOT process.cwd(). Pointing the broker at
    // the repo lets env_declare/env_describe read and write `env.schema.jsonc`,
    // `.env` and `.envseal/` into the source tree, and makes results depend on
    // whatever state the repo happens to be in.
    root = mkdtempSync(join(tmpdir(), 'envseal-sdk-dispatch-'));
    broker = createBroker({
      root,
      prompter: new StubPrompter() as any,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns error object for unknown tool', async () => {
    const result = await dispatch(broker, 'unknown_tool', {});
    expect(result).toEqual({
      error: {
        code: 'SEP_UNKNOWN_KEY',
        userMessage: 'Unknown tool: unknown_tool',
        retriable: false,
      },
    });
  });

  it('returns error object for invalid args', async () => {
    const result = await dispatch(broker, 'env_declare', {
      invalid: 'field',
    });
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('error.code');
    expect(result).toHaveProperty('error.userMessage');
  });

  it('returns error object (not thrown) for SepError', async () => {
    const result = await dispatch(broker, 'env_declare', {
      entries: [
        {
          key: 'TEST_KEY',
          description: 'Test',
          value: 'secret-value', // Invalid: value field not allowed
        },
      ],
    });
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('error.code');
    expect(result).toHaveProperty('error.retriable');
  });

  it('returns result object for valid env_describe', async () => {
    const result = await dispatch(broker, 'env_describe', {});
    expect(result).toHaveProperty('entries');
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it('does not throw on any dispatch call', async () => {
    const toolCalls = [
      ['env_describe', {}],
      ['env_declare', { entries: [] }], // Will fail validation but should return error object
      ['unknown', {}],
    ];

    for (const [name, args] of toolCalls) {
      const result = await dispatch(broker, name, args);
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    }
  });
});
