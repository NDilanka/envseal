import { emit, fail } from '../output.js';
import { EXIT, exitCodeForOutcome } from '../exit-codes.js';
import { createBroker, hasInteractiveSurface, outcomeForKey } from '../cli-utils.js';
import { finish } from '../exit.js';
import { loadManifest, projectPaths, saveManifest } from '@envseal/core';
import { SepError, type ManifestEntry } from '@envseal/protocol';

/**
 * Undo a declaration THIS invocation added, after nothing was stored under it.
 *
 * `set` declares before it requests (the declare-time schema guard has to run
 * first), so every attempt that did not end `stored` — a CI run with no prompt
 * surface, a cancelled or timed-out prompt, a typo the user abandons — used to
 * leave the key behind as required+secret in env.schema.jsonc. Nothing
 * mentioned the mutation: status then shows a phantom key forever, revoke
 * touches only sinks, and init does not prune. An entry that already existed
 * before this run is left alone — it was not ours to remove.
 *
 * stderr only: stdout is the machine-readable channel in --json mode.
 */
function rollbackDeclaredEntry(root: string, key: string): void {
  const paths = projectPaths(root);
  const manifest = loadManifest(paths);
  if (manifest === null) return;
  const remaining = manifest.entries.filter((e) => e.key !== key);
  if (remaining.length === manifest.entries.length) return;
  manifest.entries = remaining;
  // saveManifest edits only the changed field through jsonc, so the header
  // comments survive.
  saveManifest(paths, manifest);
  console.error(`declared ${key} but nothing was stored; declaration removed`);
}

export async function set(root: string, key: string, json: boolean): Promise<void> {
  // Whether the declare below added the entry, as opposed to finding it already
  // there. Lives outside the try so the catch can roll it back when `request`
  // throws (no interactive surface in CI is the common case).
  let declaredHere = false;

  try {
    const broker = await createBroker(root);

    // F2: same fail-closed rule as ensure/run. Without this, a non-TTY caller
    // (agent shell, scheduler) selected the loopback surface and waited on a
    // browser page nobody could see.
    //
    // The guard fires BEFORE any declare, so a refused run also leaves no
    // phantom declaration — but only for keys that are NOT already declared
    // (those keep the pre-existing rollback semantics below). CI=1 keeps the
    // original path: declare-then-request so the refusal is announced with the
    // "declared X but nothing was stored" mutation message, which the contract
    // test pins.
    const surfaceUsable =
      hasInteractiveSurface() ||
      process.env.CI !== undefined ||
      process.env.ENVSEAL_TEST_PROMPTER_VALUE !== undefined ||
      process.env.ENVSEAL_TEST_PROMPTER_OUTCOME !== undefined;
    if (!surfaceUsable) {
      throw new SepError({
        code: 'SEP_NO_INTERACTIVE_SURFACE',
        userMessage:
          'envseal set needs to collect a value, but there is no interactive surface here. ' +
          'Run it in an interactive shell, or use the documented ENVSEAL_TEST_MODE hooks in tests.',
      });
    }

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
        const declareResult = await broker.declare({
          entries: [entry],
        });
        declaredHere = declareResult.added.includes(key);
      } catch {
        // A key name the manifest schema rejects. Fall through: `request` then
        // raises SEP_NOT_DECLARED, which maps to exit 2 (usage) — the right
        // answer for a bad argument. Nothing was written, so no rollback.
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
      // it as such rather than as a silent success. Nothing was stored, so the
      // declaration we added has nothing to show for itself either.
      if (declaredHere) rollbackDeclaredEntry(root, key);
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

    if (outcome !== 'stored' && declaredHere) {
      rollbackDeclaredEntry(root, key);
    }

    const code = exitCodeForOutcome(outcome);
    if (code !== EXIT.OK) {
      finish(code);
      return;
    }
  } catch (error) {
    // `request` throws before any prompt happens (SEP_NO_INTERACTIVE_SURFACE
    // under CI=1 is the common route here), so a declaration we just added
    // would otherwise outlive a run that never even asked for the value.
    if (declaredHere) rollbackDeclaredEntry(root, key);
    fail(json, error);
  }
}
