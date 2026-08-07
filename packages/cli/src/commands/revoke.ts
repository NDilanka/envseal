import { emit, fail } from '../output.js';
import { createBroker } from '../cli-utils.js';

export async function revoke(root: string, key: string, json: boolean): Promise<void> {
  try {
    const broker = await createBroker(root);

    const results = await broker.revoke({
      keys: [key],
    });

    const result = results[0];

    if (!json) {
      if (result?.removed) {
        console.log(`✓ ${key} revoked`);
        if (result.rotateUrl) {
          console.log(`  Rotate the credential at: ${result.rotateUrl}`);
        }
      } else {
        console.log(`✗ Failed to revoke ${key}`);
      }
    } else {
      emit(json, '', {
        key,
        removed: result?.removed,
        rotateUrl: result?.rotateUrl,
      });
    }
  } catch (error) {
    fail(json, error);
  }
}
