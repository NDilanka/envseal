import { createInterface } from 'node:readline';
import { SepError } from '@envseal/protocol';
import { emit, fail } from '../output.js';
import { createBroker } from '../cli-utils.js';
import { finish } from '../exit.js';

/**
 * Ask the user to approve running a command with secrets injected.
 *
 * Without this the broker's confirmation callback is absent and `use` always
 * throws SEP_CONFIRMATION_DENIED, making the command impossible to use. The
 * prompt reads from the controlling terminal, so it still works when stdout is
 * being piped.
 *
 * Fails closed: no TTY and no --yes means no approval. That is the right
 * default, because the alternative is a CI job silently handing credentials to
 * whatever it was told to run.
 */
async function confirmInteractive(info: {
  command: string[];
  keys: string[];
  networkEgress: boolean;
}): Promise<boolean> {
  if (process.env.ENVSEAL_ASSUME_YES === '1') return true;
  if (!process.stdin.isTTY) {
    // Distinct from a refusal. Reporting "the user denied the confirmation" when
    // no human was ever asked is actively misleading, and it is the shell-only
    // agents of Tier 4 that hit this path — the ones this binding exists for.
    throw new SepError({
      code: 'SEP_NO_INTERACTIVE_SURFACE',
      userMessage:
        'envseal run needs confirmation before injecting secrets, but there is no terminal to ask on. ' +
        'Re-run in an interactive shell, or pass --yes (or set ENVSEAL_ASSUME_YES=1) to approve non-interactively.',
    });
  }

  const lines = [
    '',
    'envseal is about to run a command with secrets in its environment:',
    `  command: ${info.command.join(' ')}`,
    `  keys:    ${info.keys.join(', ')}`,
  ];
  if (info.networkEgress) {
    lines.push(
      '  WARNING: this command can make network requests, so it could send',
      '           these values somewhere. Only continue if you trust it.',
    );
  }
  lines.push('');
  process.stderr.write(lines.join('\n'));

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
