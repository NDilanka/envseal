import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSecret, SepError } from '@envseal/protocol';
import type { Prompter, PromptRequest, PromptResponse, PromptKeyResult } from '@envseal/prompters';
import { projectPaths } from '../src/paths.js';
import { Broker } from '../src/broker.js';

class StubPrompter implements Prompter {
  readonly id = 'loopback-browser' as const;
  /** Exposed so tests can assert on the exact buffer handed to the broker. */
  readonly secretValue: Buffer;

  constructor(secret: string) {
    this.secretValue = Buffer.from(secret, 'utf8');
  }

  async available(): Promise<boolean> {
    return true;
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    const results: PromptKeyResult[] = req.keys.map((key) => ({
      key: key.key,
      outcome: 'entered' as const,
      value: asSecret(this.secretValue),
    }));

    return {
      ticket: req.ticket,
      results,
    };
  }

  async cancel(): Promise<void> {
    // noop
  }
}

describe('Broker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'envseal-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('e2e flow: declare -> describe -> request -> await -> describe', async () => {
    // Use a distinctive sentinel value that should NEVER appear in any output
    const sentinel = 'sk-SENTINEL-DO-NOT-LEAK-abc123xyz789';
    const prompter = new StubPrompter(sentinel);
    const broker = new Broker({
      root: tmpDir,
      prompter,
    });

    // Declare a key
    const declareResult = await broker.declare({
      entries: [
        {
          key: 'TEST_API_KEY',
          description: 'Test API key for verification',
          required: true,
          secret: true,
        },
      ],
    });

    expect(declareResult.added).toContain('TEST_API_KEY');

    // Describe before request - key should be missing
    let status = await broker.describe();
    expect(status.missingRequired).toContain('TEST_API_KEY');
    const beforeEntry = status.entries.find((e) => e.key === 'TEST_API_KEY');
    expect(beforeEntry?.present).toBe(false);

    // Request the key
    const ticket = await broker.request({
      keys: ['TEST_API_KEY'],
      reason: 'Need key for testing',
    });

    expect(ticket.ticket).toBeDefined();
    expect(ticket.nonce).toBeDefined();

    // The ticket should be returned immediately (before prompt completes)
    const startTime = Date.now();
    const awaited = await broker.await({
      ticket: ticket.ticket,
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - startTime;

    // Should complete reasonably quickly (stub prompter is sync)
    expect(elapsed).toBeLessThan(5000);

    // Describe after await - key should be present
    status = await broker.describe();
    expect(status.missingRequired).not.toContain('TEST_API_KEY');
    const afterEntry = status.entries.find((e) => e.key === 'TEST_API_KEY');
    expect(afterEntry?.present).toBe(true);
    expect(afterEntry?.fingerprint).toMatch(/^fp_/);
    expect(afterEntry?.lengthBucket).toBeDefined();

    broker.dispose();

    // CRITICAL SECURITY TEST: ensure sentinel never leaks
    // Every caller-visible return value, not just a sample of them: the await
    // outcome is the one that carries per-key results and so is the likeliest
    // place for a value to ride along.
    const allText =
      JSON.stringify(ticket) + JSON.stringify(status) + JSON.stringify(awaited);

    expect(allText).not.toContain(sentinel);
    expect(allText).not.toContain('sk-SENTINEL');
    expect(allText).not.toContain('DO-NOT-LEAK');
  });

  it('rejects undeclared keys in request', async () => {
    const broker = new Broker({
      root: tmpDir,
    });

    try {
      await broker.request({
        keys: ['UNDECLARED_KEY'],
        reason: 'Need key',
      });
      expect.fail('Should have thrown SEP_NOT_DECLARED');
    } catch (err) {
      expect(err instanceof SepError).toBe(true);
      if (err instanceof SepError) {
        expect(err.code).toBe('SEP_NOT_DECLARED');
      }
    }

    broker.dispose();
  });

  it('describe never returns values', async () => {
    const broker = new Broker({
      root: tmpDir,
    });

    // Create a manifest with a key
    const declareResult = await broker.declare({
      entries: [
        {
          key: 'SECRET_KEY',
          description: 'Secret',
        },
      ],
    });

    expect(declareResult.added).toContain('SECRET_KEY');

    // Add a secret to the dotenv file
    const paths = projectPaths(tmpDir);
    writeFileSync(paths.dotenv, 'SECRET_KEY=my-super-secret-value\n');

    // Describe should show the key as present but not return the value
    const status = await broker.describe();
    const entry = status.entries.find((e) => e.key === 'SECRET_KEY');

    expect(entry?.present).toBe(true);
    expect(entry?.fingerprint).toBeDefined();
    expect(JSON.stringify(status)).not.toContain('my-super-secret-value');

    broker.dispose();
  });

  it('format validation rejects invalid values', async () => {
    const prompter = new StubPrompter('invalid-key');
    const broker = new Broker({
      root: tmpDir,
      prompter,
    });

    // Declare key with format requirement
    await broker.declare({
      entries: [
        {
          key: 'API_KEY',
          description: 'API key',
          format: {
            pattern: '^sk-[A-Za-z0-9]{20,}$',
            example: 'sk-XXXXXXXXXXXXXXXXXXXX',
          },
        },
      ],
    });

    const ticket = await broker.request({
      keys: ['API_KEY'],
      reason: 'Need key',
    });

    await broker.await({
      ticket: ticket.ticket,
      timeoutMs: 5000,
    });

    // Key should not be stored due to format mismatch
    const status = await broker.describe();
    const entry = status.entries.find((e) => e.key === 'API_KEY');
    expect(entry?.present).toBe(false);

    broker.dispose();
  });

  it('zeroes the entered value when the sink write fails', async () => {
    const sentinel = 'sk-SINKFAIL-DO-NOT-LEAK-abc123xyz789';
    const prompter = new StubPrompter(sentinel);
    const broker = new Broker({
      root: tmpDir,
      prompter,
    });

    await broker.declare({
      entries: [
        {
          key: 'TEST_API_KEY',
          description: 'Test API key',
          required: true,
          secret: true,
        },
      ],
    });

    // Force the dotenv sink write to fail: the target exists as a directory,
    // so the sink's read-then-rename throws SEP_SINK_WRITE_FAILED. StubPrompter
    // hands out asSecret(buffer) over the SAME buffer, so what it holds is
    // exactly what the broker had to zero.
    const paths = projectPaths(tmpDir);
    mkdirSync(paths.dotenv);

    const ticket = await broker.request({
      keys: ['TEST_API_KEY'],
      reason: 'Need key',
    });

    const outcome = await broker.await({
      ticket: ticket.ticket,
      timeoutMs: 5000,
    });

    // Existing behavior is preserved: the prompt is recorded as failed and the
    // ticket cancelled — the sink error must not silently become "stored".
    expect(outcome.state).toBe('cancelled');
    const audit = readFileSync(paths.audit, 'utf8');
    expect(audit).toContain('prompt_failed');
    expect(audit).toContain('SEP_SINK_WRITE_FAILED');

    // The regression: the entered buffer survives unzeroed in the heap on the
    // sink-write-failure path unless every exit from the value region zeroes.
    const entered = prompter.secretValue;
    expect(entered.length).toBeGreaterThan(0);
    expect(entered.every((b) => b === 0)).toBe(true);

    broker.dispose();
  });
});
