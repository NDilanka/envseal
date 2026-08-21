import { emit, fail } from '../output.js';
import { EXIT, exitCodeForOutcome } from '../exit-codes.js';
import { createBroker, outcomeForKey } from '../cli-utils.js';
import { finish } from '../exit.js';
import type { ManifestEntry } from '@envseal/protocol';

export async function set(root: string, key: string, json: boolean): Promise<void> {
  try {
    const broker = await createBroker(root);

    // Declare the key only if it is not already in the manifest.
    //
    // `declareEntries` replaces an entry wholesale rather than merging, so
    // declaring unconditionally meant `envseal set OPENAI_API_KEY` on an
    // initialised project overwrote the existing entry with this bare stub —
    // silently dropping its format pattern, its provider links and its verify
    // probe. Caught by the invalid_format case in contract-e2e.test.ts, which
    // stored a value the declared pattern rejects.
    const status = await broker.describe();
    if (!status.entries.some((e) => e.key === key)) {
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
        // A key name the manifest schema rejects. Fall through: `request` then
        // raises SEP_NOT_DECLARED, which maps to exit 2 (usage) — the right
        // answer for a bad argument.
      }
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

    const outcome = outcomeForKey(result, key);

    if (outcome === null) {
      // The ticket resolved without saying anything about the key we asked
      // for. That is an internal inconsistency, not a user decision, so report
      // it as such rather than as a silent success.
      fail(json, `The prompt for ${key} finished without reporting an outcome.`);
      return;
    }

    if (!json) {
      if (outcome === 'stored') {
        console.log(`✓ ${key} set successfully`);
      } else {
        console.log(`✗ Failed to set ${key}: ${outcome}`);
      }
    } else {
      emit(json, '', {
        key,
        outcome,
      });
    }

    const code = exitCodeForOutcome(outcome);
    if (code !== EXIT.OK) {
      finish(code);
      return;
    }
  } catch (error) {
    fail(json, error);
  }
}
