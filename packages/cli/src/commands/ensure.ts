import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { loadManifest, projectPaths } from '@envseal/core';
import { SepError } from '@envseal/protocol';
import { createBroker, outcomeForKey } from '../cli-utils.js';
import { finish } from '../exit.js';

export async function ensure(root: string, json: boolean, check = false): Promise<void> {
  try {
    // A project without env.schema.jsonc declares NOTHING, but describe()
    // reports that exactly like an empty manifest: zero missing keys, so this
    // used to print "✓ All required keys are satisfied" and exit 0 — vacuous
    // success from the command whose job is telling the truth, while doctor on
    // the same project reported the missing declarations.
    //
    // Exit USAGE (2), not UNSATISFIED (1): 1 means "required keys are still
    // missing after the operation", and there are no keys here to satisfy.
    // This is the same class as SEP_NOT_DECLARED, which already maps to 2.
    // (`status` keeps exiting 0 on an init-less project because it is a
    // read-only report with genuinely nothing to show; `ensure` claims work
    // done, so it may not.) The message below differs from the missing-keys
    // failure ("✗ Only N/M keys set" / satisfied:false), so scripts can tell
    // the two apart by text as well as code.
    const manifest = loadManifest(projectPaths(root));
    if (manifest === null) {
      throw new SepError({
        code: 'SEP_NOT_DECLARED',
        userMessage:
          'No env.schema.jsonc in this project (or parents). Run `envseal init` to create one.',
      });
    }

    const broker = await createBroker(root);
    const status = await broker.describe();

    // Use missingRequired array from ManifestStatus
    const missingRequired = status.missingRequired;

    // --check is the headless gate: it reports and exits, never requests.
    // Skipping broker.request() is what makes it prompt-free — not just under
    // CI (where a request would exit 4) but in an interactive terminal too,
    // where a request would open a dialog the caller of a *check* never asked
    // for. Total counts required entries only: an optional key being absent
    // is not a failure.
    if (check) {
      const total = manifest.entries.filter((e) => e.required).length;
      const missing = missingRequired.length;
      if (!json) {
        if (missing === 0) {
          console.log('✓ All required keys are satisfied');
        } else {
          console.log(`✗ ${missing} of ${total} required key(s) missing:`);
          for (const key of missingRequired) {
            console.log(`  ${key}`);
          }
        }
      } else {
        emit(json, '', {
          satisfied: missing === 0,
          keysSet: total - missing,
          total,
          missing: missingRequired,
        });
      }
      if (missing > 0) {
        finish(EXIT.UNSATISFIED);
      }
      return;
    }

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
