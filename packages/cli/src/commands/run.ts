import { createInterface } from 'node:readline';
import { SepError } from '@envseal/protocol';
import { useConfirmationBody, type TargetInfo } from '@envseal/core';
import { emit, fail } from '../output.js';
import { createBroker } from '../cli-utils.js';
import { loadManifest, projectPaths } from '@envseal/core';
import { finish } from '../exit.js';

/**
 * Ask the user to approve running a command with secrets injected.
 *
 * Without this the broker's confirmation callback is absent and `use` always
 * throws SEP_CONFIRMATION_DENIED, making the command impossible to use. The
 * prompt reads from the controlling terminal, so it still works when stdout is
 * being piped.
 *
 * The dialog body comes from the SAME useConfirmationBody the MCP and SDK
 * bindings render — one escaping/fingerprint implementation for every
 * surface. Fails closed: no TTY and no --yes means no approval. That is the
 * right default, because the alternative is a CI job silently handing
 * credentials to whatever it was told to run.
 */
async function confirmInteractive(info: {
  command: string[];
  keys: string[];
  networkEgress: boolean;
  target: TargetInfo;
}): Promise<boolean> {
  if (process.env.ENVSEAL_ASSUME_YES === '1') return true;
  if (!process.stdin.isTTY) {
    // Distinct from a refusal. Reporting "the user denied the confirmation" when
    // no human was ever asked is actively misleading, and it is the shell-only
    // agents of Tier 4 that hit this path — the ones this binding exists for.
    // Deliberately silent about HOW to proceed headlessly: this message lands in
    // agent-visible stderr, and advertising the bypass here handed every reader
    // a one-liner to skip the dialog entirely (documented in docs/ci.md instead).
    throw new SepError({
      code: 'SEP_NO_INTERACTIVE_SURFACE',
      userMessage:
        'envseal run needs confirmation before injecting secrets, but there is no terminal to ask on. ' +
        'Nothing was run and no value was read. Re-run it yourself in an interactive shell to review and ' +
        'approve the command; see docs/ci.md for the supported headless pipeline setup.',
    });
  }

  const body = useConfirmationBody(info, process.cwd());
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

export async function run(
  root: string,
  command: string[],
  json: boolean,
  assumeYes = false,
): Promise<void> {
  try {
    const broker = await createBroker(root, {
      onConfirm: assumeYes ? async () => true : confirmInteractive,
    });
    // F4: a missing manifest while values still resolve is a suspicious state
    // (deleted by hand or tooling). The run proceeds — the .env is user-owned —
    // but never silently: the condition goes to stderr in both output modes.
    if (loadManifest(projectPaths(root)) === null) {
      const warning =
        'envseal: no env.schema.jsonc found for this project. ' +
        'Values are still resolved from .env/keychain because those are user-owned, ' +
        "but nothing is declared here anymore. Run `envseal init` to re-create the manifest.";
      process.stderr.write(`\n${warning}\n\n`);
    }
    const status = await broker.describe();

    const presentKeys = status.entries.filter((e) => e.present).map((e) => e.key);

    const result = await broker.use({ keys: presentKeys, command });

    if (!json) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    } else {
      emit(json, '', {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        redactedCount: result.redactedCount,
      });
    }

    finish(result.exitCode ?? 0);
    return;
  } catch (error) {
    fail(json, error);
  }
}
