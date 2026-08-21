import { projectPaths } from '@envseal/core';
import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { createBroker } from '../cli-utils.js';
import { finish } from '../exit.js';
import { makeProbeApprover } from '../probe-approval.js';

export async function verify(
  root: string,
  keys: string[],
  json: boolean,
): Promise<void> {
  try {
    const paths = projectPaths(root);
    const broker = await createBroker(root, {
      onApprovalNeeded: makeProbeApprover(paths.approvals),
    });
    const status = await broker.describe();

    // Verify specified keys, or all if none specified
    const keysToVerify =
      keys.length > 0
        ? keys
        : status.entries.map((e) => e.key);

    const results = await broker.verify({
      keys: keysToVerify,
    });

    let allOk = true;
    for (const result of results) {
      if (result.result !== 'ok') {
        allOk = false;
      }
    }

    if (!json) {
      for (const result of results) {
        const status_str = result.result === 'ok' ? '✓' : '✗';
        console.log(`${status_str} ${result.key}: ${result.result}`);
      }
    } else {
      emit(json, '', {
        results: results.map((r) => ({
          key: r.key,
          result: r.result,
          message: r.message,
        })),
        allOk,
      });
    }

    if (!allOk) {
      finish(EXIT.VERIFY_FAILED);
      return;
    }
  } catch (error) {
    fail(json, error);
  }
}
