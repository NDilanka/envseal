import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { createBroker, outcomeForKey } from '../cli-utils.js';
import { finish } from '../exit.js';

export async function ensure(root: string, json: boolean): Promise<void> {
  try {
    const broker = await createBroker(root);
    const status = await broker.describe();

    // Use missingRequired array from ManifestStatus
    const missingRequired = status.missingRequired;

    if (missingRequired.length === 0) {
      if (!json) {
        console.log('✓ All required keys are satisfied');
      } else {
        // `total` is part of the documented shape and was omitted here, so a
        // caller reading `total` got undefined on exactly the path it is most
        // likely to take. Nothing was missing, so nothing was requested: 0.
        emit(json, '', {
          satisfied: true,
          keysSet: 0,
          total: 0,
        });
      }
      return;
    }

    // Request all missing keys at once
    const ticket = await broker.request({
      keys: missingRequired,
      reason: 'Ensure all required keys are present',
    });

    // Await the results (timeoutMs defaults to 90000)
    const results = await broker.await({
      ticket: ticket.ticket,
      timeoutMs: 90000,
    });

    const outcomes = missingRequired.map((key) => outcomeForKey(results, key));
    const keysSet = outcomes.filter((o) => o === 'stored').length;
    const allSet = keysSet === missingRequired.length;

    if (!json) {
      if (allSet) {
        console.log(`✓ Set ${keysSet} key(s)`);
      } else {
        console.log(`✗ Only ${keysSet}/${missingRequired.length} keys set`);
      }
    } else {
      emit(json, '', {
        satisfied: allSet,
        keysSet,
        total: missingRequired.length,
      });
    }

    if (!allSet) {
      // Exit 1 says "still missing"; exit 3 says "a human declined or never
      // answered". Both are retriable, but only 3 tells a caller that retrying
      // unattended is pointless — so a stop of that kind wins over a plain
      // shortfall. Everything else (skipped, invalid_format, verify_failed)
      // stays 1.
      const stopped = outcomes.some((o) => o === 'cancelled' || o === 'timeout');
      finish(stopped ? EXIT.CANCELLED : EXIT.UNSATISFIED);
      return;
    }
  } catch (error) {
    fail(json, error);
  }
}
