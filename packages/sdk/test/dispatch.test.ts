import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBroker, dispatch } from '../src/index.js';
import { Broker } from '@envseal/core';
import { secretFromUtf8 } from '@envseal/protocol';
import type { Prompter, PromptRequest, PromptResponse } from '@envseal/prompters';

const REVOKE_KEY = 'REVOKE_TEST_KEY';
const REVOKE_SENTINEL = 'sk-REVOKE-SENTINEL-DO-NOT-LEAK-abc123';
const USE_KEY = 'USE_TEST_KEY';
const USE_SENTINEL = 'sk-USE-SENTINEL-DO-NOT-LEAK-xyz789';

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
    writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
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

  it('reports an unanswered confirmation as SEP_TICKET_EXPIRED, never as a denial', async () => {
    // A confirmation whose TTL fires with nobody at it resolves with outcome
    // `timeout`. Reporting that as SEP_CONFIRMATION_DENIED would tell the
    // model "The user denied the confirmation." for a user who never spoke.
    const refusing: Prompter = {
      id: 'ide',
      available: async () => true,
      prompt: async (req: PromptRequest): Promise<PromptResponse> => ({
        ticket: req.ticket,
        results: req.keys.map((k) => ({ key: k.key, outcome: 'timeout' as const })),
      }),
      cancel: async () => {},
    };
    writeFileSync(
      join(root, 'env.schema.jsonc'),
      JSON.stringify({
        version: 1,
        entries: [{ key: USE_KEY, description: 'use test', required: true, secret: true, sink: 'dotenv' }],
      }),
      'utf8',
    );
    writeFileSync(join(root, '.env'), `${USE_KEY}=${USE_SENTINEL}\n`, 'utf8');

    const result = await dispatch(createBroker({ root, prompter: refusing }), 'env_use', {
      keys: [USE_KEY],
      command: [process.execPath, '-e', 'process.exit(0)'],
    });

    expect(result).toMatchObject({
      error: { code: 'SEP_TICKET_EXPIRED', retriable: true },
    });
    const message = JSON.stringify(result);
    expect(message).not.toContain('The user denied');
    expect(message).toContain('nobody answering');
    expect(message).not.toContain(USE_SENTINEL);
  });

  it('reports an unanswered revoke confirmation as SEP_TICKET_EXPIRED, never as a denial', async () => {
    const refusing: Prompter = {
      id: 'ide',
      available: async () => true,
      prompt: async (req: PromptRequest): Promise<PromptResponse> => ({
        ticket: req.ticket,
        results: req.keys.map((k) => ({ key: k.key, outcome: 'timeout' as const })),
      }),
      cancel: async () => {},
    };
    writeFileSync(
      join(root, 'env.schema.jsonc'),
      JSON.stringify({
        version: 1,
        entries: [{ key: REVOKE_KEY, description: 'revoke test', required: true, secret: true, sink: 'dotenv' }],
      }),
      'utf8',
    );
    writeFileSync(join(root, '.env'), `${REVOKE_KEY}=${REVOKE_SENTINEL}\n`, 'utf8');

    const result = await dispatch(createBroker({ root, prompter: refusing }), 'env_revoke', {
      keys: [REVOKE_KEY],
    });

    expect(result).toMatchObject({
      error: { code: 'SEP_TICKET_EXPIRED', retriable: true },
    });
    const message = JSON.stringify(result);
    expect(message).not.toContain('The user denied');
    expect(message).not.toContain(REVOKE_SENTINEL);
  });

  it('removes the key when the user approves revoke, without returning the value', async () => {
    const approving: Prompter = {
      id: 'ide',
      available: async () => true,
      prompt: async (req: PromptRequest): Promise<PromptResponse> => ({
        ticket: req.ticket,
        results: req.keys.map((k) => ({
          key: k.key,
          outcome: 'entered' as const,
          value: secretFromUtf8('yes'),
        })),
      }),
      cancel: async () => {},
    };
    writeFileSync(
      join(root, 'env.schema.jsonc'),
      JSON.stringify({
        version: 1,
        entries: [{ key: REVOKE_KEY, description: 'revoke test', required: true, secret: true, sink: 'dotenv' }],
      }),
      'utf8',
    );
    writeFileSync(join(root, '.env'), `${REVOKE_KEY}=${REVOKE_SENTINEL}\n`, 'utf8');

    const result = await dispatch(createBroker({ root, prompter: approving }), 'env_revoke', {
      keys: [REVOKE_KEY],
    });

    expect(result).toEqual([{ key: REVOKE_KEY, removed: true, rotateUrl: null }]);
    expect(JSON.stringify(result)).not.toContain(REVOKE_SENTINEL);
  });

  it('denies revoke without removing the stored key', async () => {
    const denying: Prompter = {
      id: 'ide',
      available: async () => true,
      prompt: async (req: PromptRequest): Promise<PromptResponse> => ({
        ticket: req.ticket,
        results: req.keys.map((k) => ({
          key: k.key,
          outcome: 'entered' as const,
          value: secretFromUtf8('no'),
        })),
      }),
      cancel: async () => {},
    };
    writeFileSync(
      join(root, 'env.schema.jsonc'),
      JSON.stringify({
        version: 1,
        entries: [{ key: REVOKE_KEY, description: 'revoke test', required: true, secret: true, sink: 'dotenv' }],
      }),
      'utf8',
    );
    writeFileSync(join(root, '.env'), `${REVOKE_KEY}=${REVOKE_SENTINEL}\n`, 'utf8');

    const result = await dispatch(createBroker({ root, prompter: denying }), 'env_revoke', {
      keys: [REVOKE_KEY],
    });

    expect(result).toMatchObject({ error: { code: 'SEP_CONFIRMATION_DENIED' } });
    expect(JSON.stringify(result)).not.toContain(REVOKE_SENTINEL);
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
