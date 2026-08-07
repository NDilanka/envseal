import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { createBroker } from '../cli-utils.js';

export async function status(
  root: string,
  keys: string[],
  json: boolean,
): Promise<void> {
  try {
    const broker = await createBroker(root);
    const status = await broker.describe();

    let entriesToShow = status.entries;
    if (keys.length > 0) {
      entriesToShow = entriesToShow.filter((e) => keys.includes(e.key));
    }

    const hasRequired = status.missingRequired.length > 0;

    if (!json && keys.length === 0) {
      if (entriesToShow.length === 0) {
        console.log('No environment variables declared.');
      } else {
        for (const entry of entriesToShow) {
          const status_str = entry.present ? '✓' : '✗';
          console.log(`${status_str} ${entry.key}`);
        }
      }
    } else {
      emit(json, '', {
        entries: entriesToShow.map((e) => ({
          key: e.key,
          present: e.present,
          sink: e.sink,
          formatValid: e.formatValid,
          lengthBucket: e.lengthBucket,
          fingerprint: e.fingerprint,
          lastVerified: e.lastVerified,
          verifyResult: e.verifyResult,
        })),
      });
    }

    // Exit with UNSATISFIED if required keys are missing
    if (hasRequired) {
      process.exit(EXIT.UNSATISFIED);
    }
  } catch (error) {
    fail(json, error);
  }
}
