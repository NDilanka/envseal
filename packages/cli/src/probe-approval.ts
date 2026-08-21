import { createInterface } from 'node:readline';
import type { ManifestEntry } from '@envseal/protocol';
import { hasInteractiveSurface } from './cli-utils.js';

/**
 * Probe-approval consent for `envseal verify` (PLAN.md §6.4, SPEC.md 507-511).
 *
 * `env_verify` sends the real credential to whatever host the manifest's
 * `verify.url` names. For hosts on the bundled registry allowlist that is the
 * provider the key belongs to. For anything else it is an exfiltration
 * primitive: the manifest is model-writable via `env_declare`, so a model that
 * can declare a key can also name where the key gets posted.
 *
 * Core implements the consent record; nothing in the shipped product supplied
 * the callback, so the whole flow was dead code and every off-allowlist probe
 * came back `probe_not_approved` with no way for the user to say yes.
 *
 * Everything here writes to stderr. `envseal verify --json` must leave stdout
 * as exactly one JSON object.
 */

type ProbeSpec = NonNullable<ManifestEntry['verify']>;

/**
 * A fixed answer for the approval question, for tests only.
 *
 * Double-gated exactly like the stub prompter in test-prompter.ts: the caller
 * must set BOTH `ENVSEAL_TEST_MODE=1` and `ENVSEAL_TEST_APPROVAL` to `yes` or
 * `no`. Neither is ever set by the shipped CLI. This is a deliberate hole in
 * "a probe to an unknown host is only ever approved by a human", which is why
 * it costs two variables — and why the notice is still printed when it fires,
 * so the display path stays under test rather than being skipped.
 */
function forcedAnswer(): boolean | null {
  if (process.env.ENVSEAL_TEST_MODE !== '1') return null;
  const answer = process.env.ENVSEAL_TEST_APPROVAL;
  if (answer === 'yes') return true;
  if (answer === 'no') return false;
  return null;
}

function describeProbe(key: string, probe: ProbeSpec, hostname: string): string[] {
  const lines = [
    '',
    `envseal needs your approval before verifying ${key}.`,
    `${hostname} is not on the built-in registry allowlist, so this probe would send`,
    'the credential to a host envseal cannot vouch for.',
    '',
    `  key:     ${key}`,
    `  host:    ${hostname}`,
    `  method:  ${probe.method}`,
    `  url:     ${probe.url}`,
    '  headers:',
  ];
  for (const [name, template] of Object.entries(probe.headerTemplate)) {
    lines.push(`    ${name}: ${template}`);
  }
  lines.push(
    '',
    '{{value}} is where your credential is substituted at request time. The value',
    'itself is never printed here, and never written to the approval record.',
    '',
  );
  return lines;
}

function noSurfaceNotice(key: string, approvalsPath: string): string[] {
  const reason =
    process.env.CI !== undefined
      ? 'CI is set in the environment'
      : 'stdin is not a terminal';
  return [
    `Cannot ask: ${reason}, so there is nobody to answer.`,
    `The probe was NOT sent and ${key} is reported as probe_not_approved.`,
    'To approve it, run this once in an interactive terminal on a machine with',
    `access to this project:  envseal verify ${key}`,
    `The decision is recorded in ${approvalsPath} and replayed without asking again,`,
    'until the key, method, URL or header template changes.',
    '',
  ];
}

/**
 * Build the `onApprovalNeeded` callback for the broker.
 *
 * Fails closed: with no interactive surface it returns false rather than
 * hanging on a read nobody will answer, and rather than approving silently.
 * Core turns that false into `probe_not_approved`, so `verify` still exits 6.
 */
export function makeProbeApprover(
  approvalsPath: string,
): (entry: ManifestEntry) => Promise<boolean> {
  return async (entry: ManifestEntry): Promise<boolean> => {
    const probe = entry.verify;
    if (probe === undefined) {
      // Core only reaches this callback for entries that declare a probe.
      // Refusing keeps a broken invariant a refusal rather than a crash.
      return false;
    }
    const hostname = new URL(probe.url).hostname;

    process.stderr.write(`${describeProbe(entry.key, probe, hostname).join('\n')}\n`);

    const forced = forcedAnswer();
    if (forced !== null) {
      process.stderr.write(
        `ENVSEAL_TEST_MODE: approval answered '${forced ? 'yes' : 'no'}' from ENVSEAL_TEST_APPROVAL.\n`,
      );
      return forced;
    }

    if (!hasInteractiveSurface()) {
      process.stderr.write(`${noSurfaceNotice(entry.key, approvalsPath).join('\n')}\n`);
      return false;
    }

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Send ${entry.key} to ${hostname}? [y/N] `, resolve);
      });
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}
