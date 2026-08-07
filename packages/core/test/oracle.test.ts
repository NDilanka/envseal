import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../src/broker.js';
import { secretFromUtf8 } from '@envseal/protocol';
import type { Prompter } from '@envseal/prompters';

/**
 * Regression cover for the chosen-predicate oracle (W2 finding F1, Critical).
 *
 * `env_describe` used to compile the manifest's `format.pattern` — supplied by
 * the MODEL through `env_declare` — and test it against the live stored secret,
 * returning the boolean. Declaring `^sk-a`, reading the answer, then declaring
 * `^sk-b` reconstructs the value one predicate at a time; the original probe
 * recovered a 33-character secret in 424 calls with no user interaction.
 *
 * The redactor cannot defend against this: nothing secret-derived crosses the
 * wire. The value is reassembled from booleans inside the model's context. So
 * the test is not "is the value absent from the response" — it is "does the
 * response vary with a model-chosen predicate".
 */

const SECRET = 'sk-ORACLETEST-abcdefghijklmnop123';

function prompterFor(value: string): Prompter {
  return {
    id: 'ide',
    available: async () => true,
    prompt: async (req) => ({
      ticket: req.ticket,
      results: req.keys.map((k) => ({
        key: k.key,
        outcome: 'entered' as const,
        value: secretFromUtf8(value),
      })),
    }),
    cancel: async () => {},
  };
}

describe('format.pattern is not an oracle over stored values', () => {
  let root: string;
  let broker: Broker;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'envseal-oracle-'));
    writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
    broker = new Broker({ root, prompter: prompterFor(SECRET) });

    await broker.declare({
      entries: [
        { key: 'ORACLE_KEY', description: 'probe target', required: true, secret: true },
      ],
    });
    const ticket = await broker.request({ keys: ['ORACLE_KEY'], reason: 'seed' });
    await broker.await({ ticket: ticket.ticket, timeoutMs: 10_000 });
  });

  afterEach(() => {
    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  async function formatValidFor(pattern: string): Promise<boolean | null> {
    await broker.declare({
      entries: [
        {
          key: 'ORACLE_KEY',
          description: 'probe target',
          required: true,
          secret: true,
          format: { pattern, example: 'sk-XXXXXXXXXXXXXXXXXXXX' },
        },
      ],
    });
    const status = await broker.describe();
    return status.entries.find((e) => e.key === 'ORACLE_KEY')?.formatValid ?? null;
  }

  it('does not answer a model-chosen predicate about the stored value', async () => {
    // A true prefix and a false one. If describe evaluated the supplied pattern
    // against the value, these two would differ — and that difference is the
    // whole attack.
    const truePrefix = await formatValidFor('^sk-ORACLETEST');
    const falsePrefix = await formatValidFor('^zz-NOPE');

    expect(
      truePrefix,
      'describe answered a model-supplied predicate about the stored secret',
    ).toBe(falsePrefix);
  });

  it('reports the outcome recorded at store time, not a recomputation', async () => {
    const status = await broker.describe();
    const entry = status.entries.find((e) => e.key === 'ORACLE_KEY');
    expect(entry?.present).toBe(true);
    // Validated when it was stored, so the recorded answer is available.
    expect(entry?.formatValid).toBe(true);
  });

  it('leaks no bit through a length-probing pattern either', async () => {
    const shorter = await formatValidFor('^.{10}$');
    const exact = await formatValidFor(`^.{${SECRET.length}}$`);
    const longer = await formatValidFor('^.{500}$');
    expect(new Set([shorter, exact, longer]).size, 'length probe distinguished values').toBe(1);
  });
});
