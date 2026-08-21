import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { createBroker } from '../cli-utils.js';
import { finish } from '../exit.js';

export async function revoke(root: string, key: string, json: boolean): Promise<void> {
  try {
    const broker = await createBroker(root);

    const results = await broker.revoke({
      keys: [key],
    });

    // `broker.revoke` skips keys that are not in the manifest, so an unknown
    // key comes back as an empty array rather than `removed: false`.
    const result = results[0];
    const removed = result?.removed ?? false;
    const rotateUrl = result?.rotateUrl ?? null;

    if (!json) {
      if (removed) {
        console.log(`✓ ${key} revoked`);
        if (rotateUrl) {
          console.log(`  Rotate the credential at: ${rotateUrl}`);
        }
      } else if (result === undefined) {
        console.log(`✗ ${key} is not declared in this project's manifest`);
      } else {
        console.log(`✗ Failed to revoke ${key}: nothing was removed from the sink`);
      }
    } else {
      emit(json, '', {
        key,
        removed,
        rotateUrl,
      });
    }

    // Exit 0 meant "revoked" even when nothing was removed, so a caller could
    // not distinguish a burned key from a no-op.
    if (!removed) {
      finish(EXIT.UNSATISFIED);
      return;
    }
  } catch (error) {
    fail(json, error);
  }
}
