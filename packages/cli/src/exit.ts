/**
 * Process termination for the CLI.
 *
 * `process.exit()` is the wrong tool here and was the cause of launch blocker
 * B4. Two independent problems:
 *
 * 1. On Windows, calling `process.exit()` while undici is tearing down the
 *    sockets a completed `fetch()` left behind trips a libuv assertion —
 *    `!(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76` —
 *    and the process dies with 0xC0000409 (3221226505). An agent branching on
 *    the exit code sees a crash instead of the documented 6. Reproduced 4/5
 *    runs before this change; see scripts/probe-b4-repro.mjs. Flushing stdout
 *    first does NOT help: the assertion is about the fetch handles, not stdout.
 * 2. `process.exit()` truncates a pending stdout write to a pipe, which is
 *    exactly what a shell-only caller reads from.
 *
 * So the normal path never calls `process.exit()`. It releases everything the
 * CLI owns, sets `process.exitCode`, and lets the event loop drain — which is
 * also the only way Node guarantees stdout is flushed. An *unref'd* watchdog
 * covers the case where a handle we do not own keeps the loop alive: being
 * unref'd it cannot delay the normal path, and it only fires if the process
 * would otherwise hang.
 */

/** How long the loop may stay alive after we are done before we force the issue. */
const HANG_GRACE_MS = 1500;

/** How long a forced exit waits for stdout to reach the pipe. */
const FLUSH_GRACE_MS = 250;

const disposables = new Set<() => void>();

/**
 * Register a teardown callback to run before the process finishes.
 * Every broker the CLI creates registers its `dispose()` here, which clears the
 * ticket store's sweep interval and drops its waiters.
 */
export function registerDisposable(dispose: () => void): void {
  disposables.add(dispose);
}

function disposeAll(): void {
  for (const dispose of disposables) {
    try {
      dispose();
    } catch {
      // Teardown must never mask or change the outcome we are reporting.
    }
  }
  disposables.clear();
}

/**
 * Finish the process with `code`.
 *
 * Returns normally — it is NOT `never`. Callers must `return` after calling it,
 * because execution continues until the current call stack unwinds.
 */
export function finish(code: number): void {
  disposeAll();
  process.exitCode = code;

  const watchdog = setTimeout(() => {
    // Something outside the CLI's ownership is still holding the event loop
    // open. Forcing the exit is the lesser evil against a command that never
    // returns, but give the pending stdout write a chance to land first.
    process.stdout.write('', () => process.exit(code));
    setTimeout(() => process.exit(code), FLUSH_GRACE_MS).unref();
  }, HANG_GRACE_MS);
  watchdog.unref();
}
