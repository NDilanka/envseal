import { createInterface } from 'node:readline';
import { SepError } from '@envseal/protocol';
import { revokeConfirmationBody } from '@envseal/core';
import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { createBroker } from '../cli-utils.js';
import { finish } from '../exit.js';

/**
 * Ask the user to approve removing stored credentials.
 *
 * Without this the broker's revoke confirmation callback is absent and
 * `revoke` always throws SEP_CONFIRMATION_DENIED. Mirrors run.ts: same
 * TTY/--yes/ENVSEAL_ASSUME_YES gate, same fail-closed default for headless.
 */
async function confirmRevokeInteractive(keys: string[]): Promise<boolean> {
  if (process.env.ENVSEAL_ASSUME_YES === '1') return true;
  if (!process.stdin.isTTY) {
    throw new SepError({
      code: 'SEP_NO_INTERACTIVE_SURFACE',
      userMessage:
        'envseal revoke needs confirmation before removing stored credentials, but there is no terminal to ask on. ' +
        'Nothing was removed. Re-run it yourself in an interactive shell to review and ' +
        'approve the revocation; see docs/ci.md for the supported headless pipeline setup.',
    });
  }

  const body = revokeConfirmationBody(keys, process.cwd());
  process.stderr.write(`\n${body}\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question('Continue? [y/N] ', resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function revoke(
  root: string,
  key: string,
  json: boolean,
  assumeYes = false,
): Promise<void> {
  try {
    const broker = await createBroker(root, {
      onRevokeConfirm: assumeYes
        ? async () => true
        : async (keys) => confirmRevokeInteractive(keys),
    });

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
