import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { createBroker } from '../cli-utils.js';

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
        emit(json, '', {
          satisfied: true,
          keysSet: 0,
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

    const keysSet = results.keys.filter((r) => r.outcome === 'stored').length;
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
      process.exit(EXIT.UNSATISFIED);
    }
  } catch (error) {
    fail(json, error);
  }
}
