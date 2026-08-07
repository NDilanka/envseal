import { emit, fail } from '../output.js';
import { createBroker } from '../cli-utils.js';
import type { ManifestEntry } from '@envseal/protocol';

export async function set(root: string, key: string, json: boolean): Promise<void> {
  try {
    const broker = await createBroker(root);

    // Declare the key if not already declared
    try {
      const entry: ManifestEntry = {
        key,
        description: `Configuration for ${key}`,
        required: true,
        secret: true,
        sink: 'dotenv',
      };
      await broker.declare({
        entries: [entry],
      });
    } catch {
      // Key already declared, continue
    }

    // Request the key
    const ticket = await broker.request({
      keys: [key],
      reason: `Set ${key}`,
    });

    // Await the result (timeoutMs defaults to 90000)
    const result = await broker.await({
      ticket: ticket.ticket,
      timeoutMs: 90000,
    });

    const outcome = result.keys[0];
    if (!outcome) {
      throw new Error('No outcome returned');
    }

    if (!json) {
      if (outcome.outcome === 'stored') {
        console.log(`✓ ${key} set successfully`);
      } else {
        console.log(`✗ Failed to set ${key}: ${outcome.outcome}`);
      }
    } else {
      emit(json, '', {
        key,
        outcome: outcome.outcome,
      });
    }
  } catch (error) {
    fail(json, error);
  }
}
