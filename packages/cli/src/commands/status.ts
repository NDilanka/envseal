import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { createBroker } from '../cli-utils.js';
import { finish } from '../exit.js';

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
          const due = describeRotation(entry.rotationDue);
          console.log(`${status_str} ${entry.key}${due}`);
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
          rotationDue: e.rotationDue,
        })),
      });
    }

    // Exit with UNSATISFIED if required keys are missing
    if (hasRequired) {
      finish(EXIT.UNSATISFIED);
      return;
    }
  } catch (error) {
    fail(json, error);
  }
}

/**
 * Overdue rotation is the only state worth a human's glance in the terse
 * listing; a future due date is noise. Absent policy or unknown age (hand
 * written .env before first status) reports nothing.
 */
function describeRotation(rotationDue: string | null): string {
  if (rotationDue === null) return '';
  const due = Date.parse(rotationDue);
  if (Number.isNaN(due)) return '';
  if (due > Date.now()) return '';
  const days = Math.floor((Date.now() - due) / (24 * 60 * 60 * 1000));
  const when = days === 0 ? 'today' : `${days}d ago`;
  return ` (rotation overdue, due ${rotationDue.slice(0, 10)}, ${when})`;
}
