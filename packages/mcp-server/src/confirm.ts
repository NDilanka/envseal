import { randomBytes } from 'node:crypto';
import type { BrokerOptions } from '@envseal/core';
import type { ManifestEntry, VerifyResult } from '@envseal/protocol';
import { SepError, zero } from '@envseal/protocol';
import type { Prompter } from '@envseal/prompters';
import { makeDisplayNonce } from '@envseal/prompters';

/**
 * The interactive consent surface for the two operations that move a live
 * value: `env_use` (inject into a child process) and `env_verify` against a
 * host the registry does not allowlist.
 *
 * Before this existed, three of the four bindings constructed the Broker with
 * no `onConfirm`, and exec.ts turned that absence into
 * SEP_CONFIRMATION_DENIED — "The user denied the confirmation" — when no user
 * had been asked and no user had denied. `env_use` was advertised in
 * tools/list and in the OpenAPI document and could never succeed.
 *
 * There is deliberately no environment-variable bypass here. `envseal run`
 * honours ENVSEAL_ASSUME_YES because a human typed that command; in these
 * bindings the argv comes from a *model*, and this prompt is the only thing
 * between a prompt-injected model and arbitrary code holding live
 * credentials. In CI these operations are simply unavailable, and say so.
 *
 * DUPLICATION: this file is a hand-maintained twin of
 * packages/sdk/src/confirm.ts. Its natural home is a `confirm()` method
 * on the `Prompter` interface — every surface already knows how to draw a
 * dialog — but @envseal/mcp-server does not depend on @envseal/sdk, and
 * @envseal/prompters was outside the scope of the change that added this. Both
 * packages test the behaviour independently, so drift shows up as a red test
 * rather than as a binding that quietly stops asking.
 */

/** Value-entry key name carrying the `env_use` confirmation. */
export const CONFIRM_KEY_USE = 'APPROVE';
/** Value-entry key name carrying the `env_verify` probe-consent question. */
export const CONFIRM_KEY_PROBE = 'APPROVE_PROBE';

const DEFAULT_TIMEOUT_MS = 120_000;
/** Per-argument display cap; longer arguments are shown truncated, and said to be. */
const MAX_ARG_CHARS = 300;
/** Whole-dialog cap. Past this we refuse rather than ask about something unreadable. */
const MAX_BODY_CHARS = 16 * 1024;

const INSTRUCTION = 'Type yes to approve, or submit an empty box to deny.';

export interface ConfirmSurface {
  /** Shown so the user can tell which project is asking. */
  projectRoot: string;
  /**
   * Resolves the surface to ask on. A thunk rather than a Prompter because
   * `selectPrompter()` is async and `createBroker` is not.
   */
  prompter: () => Promise<Prompter>;
  timeoutMs?: number;
}

type AskOutcome = 'approved' | 'denied' | 'timed-out' | 'no-surface' | 'busy' | 'too-large';

/**
 * Only one confirmation may be open per process. Without this a model can call
 * `env_use` in a loop and stack up dialogs until one gets clicked through.
 */
let confirmationOpen = false;

/**
 * Model-supplied argv, key names and probe metadata land in a dialog the user
 * is about to trust. A raw newline lets a crafted argument forge extra lines —
 * "keys: none", "this command is safe" — inside the very block that exists to
 * tell the truth about the command. Render control characters visibly instead.
 */
function escapeForDisplay(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `<0x${code.toString(16).padStart(2, '0')}>`;
    } else {
      out += ch;
    }
  }
  return out;
}

function displayArg(arg: string): string {
  const escaped = escapeForDisplay(arg);
  if (escaped.length <= MAX_ARG_CHARS) {
    return escaped;
  }
  const hidden = escaped.length - MAX_ARG_CHARS;
  return `${escaped.slice(0, MAX_ARG_CHARS)}[... ${hidden} more characters, not shown]`;
}

export function useConfirmationBody(
  info: { command: string[]; keys: string[]; networkEgress: boolean },
  projectRoot: string,
): string {
  const lines: string[] = [
    'EnvSeal is about to run a program with these secrets in its environment.',
    '',
    `  project: ${escapeForDisplay(projectRoot)}`,
    `  keys:    ${info.keys.length > 0 ? info.keys.map(escapeForDisplay).join(', ') : '(none)'}`,
    '',
    '  command, one argument per line, exactly as it will be run (no shell):',
  ];
  info.command.forEach((arg, index) => {
    lines.push(`    [${index}] ${displayArg(arg)}`);
  });
  lines.push('');
  if (info.networkEgress) {
    lines.push(
      '  WARNING: this command can reach the network, so it could send these',
      '           values somewhere. Only continue if you trust it.',
    );
  } else {
    // Honest about what the check is worth: NETWORK_TOOLS plus a URL scan is a
    // heuristic, and claiming more would be the kind of overstatement this
    // project has already had to walk back once.
    lines.push(
      '  No network tool or URL was recognised in this command. That is a',
      '  heuristic, not a guarantee: any program can open a socket.',
    );
  }
  lines.push('', `${INSTRUCTION} Nothing runs unless you approve.`);
  return lines.join('\n');
}

export function probeConfirmationBody(entry: ManifestEntry): string | null {
  const probe = entry.verify;
  if (!probe) {
    return null;
  }
  const lines: string[] = [
    `EnvSeal is about to send the stored value of ${escapeForDisplay(entry.key)} to a host`,
    'that is not on its bundled allowlist. Nothing has been sent yet.',
    '',
    `  key:     ${escapeForDisplay(entry.key)}`,
    `  method:  ${escapeForDisplay(probe.method)}`,
    `  url:     ${displayArg(probe.url)}`,
    '  headers:',
  ];
  for (const [header, template] of Object.entries(probe.headerTemplate)) {
    lines.push(`    ${escapeForDisplay(header)}: ${displayArg(template)}`);
  }
  lines.push(
    '',
    '  {{value}} is replaced with the real secret when the request is sent.',
    '',
    'Type yes to approve exactly this probe. The answer is recorded in',
    '.envseal/approvals.json and replayed without asking again until the',
    'method, URL or headers change. Submit an empty box to deny.',
  );
  return lines.join('\n');
}

async function ask(
  surface: ConfirmSurface,
  keyName: string,
  headline: string,
  body: string | null,
): Promise<AskOutcome> {
  if (body === null || body.length > MAX_BODY_CHARS) {
    return 'too-large';
  }

  const prompter = await surface.prompter();
  if (prompter.id === 'none') {
    return 'no-surface';
  }

  if (confirmationOpen) {
    return 'busy';
  }
  confirmationOpen = true;
  try {
    const response = await prompter.prompt({
      ticket: `confirm-${randomBytes(8).toString('hex')}`,
      nonce: makeDisplayNonce(),
      projectRoot: surface.projectRoot,
      reason: headline,
      keys: [{ key: keyName, description: body, formatHint: INSTRUCTION }],
      timeoutMs: surface.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const result = response.results.find((r) => r.key === keyName);
    // A timeout is kept apart from a denial: nobody answered at all, and
    // reporting that as "the user denied" blames a user who never spoke — the
    // defect class the CLI fixed for the missing-surface case.
    if (result !== undefined && result.outcome === 'timeout') {
      return 'timed-out';
    }
    // skipped / cancelled / a surface that answered about some other key: we
    // did not get a yes, and none of them names anyone, so they land on the
    // honest-but-blunt denial.
    if (result === undefined || result.outcome !== 'entered') {
      return 'denied';
    }
    const typed = result.value.toString('utf8');
    zero(result.value);
    return /^y(es)?$/i.test(typed.trim()) ? 'approved' : 'denied';
  } finally {
    confirmationOpen = false;
  }
}

/**
 * `onConfirm` for the Broker: gates `env_use`.
 *
 * Throws rather than returning false when no human could be asked or when the
 * ask expired with nobody answering it, because exec.ts maps a `false` to
 * SEP_CONFIRMATION_DENIED and that would blame the user for a missing surface
 * or for a silence — the defect this project already fixed once in the CLI.
 */
export function createUseConfirm(
  surface: ConfirmSurface,
): NonNullable<BrokerOptions['onConfirm']> {
  return async (info) => {
    const outcome = await ask(
      surface,
      CONFIRM_KEY_USE,
      'Approve running a command with secrets in its environment? Nothing has run yet.',
      useConfirmationBody(info, surface.projectRoot),
    );

    switch (outcome) {
      case 'approved':
        return true;
      case 'denied':
        return false;
      case 'timed-out':
        // SEP_TICKET_EXPIRED, not SEP_CONFIRMATION_DENIED: the repo already
        // treats an unanswered prompt as an expired ticket (exit-codes.ts maps
        // outcome `timeout` and this code to the same exit), and a model that
        // can tell "nobody answered" from "the user said no" retries instead
        // of reporting a refusal that never happened.
        throw new SepError({
          code: 'SEP_TICKET_EXPIRED',
          userMessage:
            'The env_use confirmation closed after its timeout with nobody answering it. Nothing was ' +
            'run and no value was read. This is not a denial: ask the user to approve it, then call ' +
            'env_use again.',
        });
      case 'no-surface':
        throw new SepError({
          code: 'SEP_NO_INTERACTIVE_SURFACE',
          userMessage:
            'env_use needs the user to confirm before secrets are injected into a child process, ' +
            'but there is no interactive surface here to ask on (this is what CI looks like to envseal). ' +
            'Nothing was run and no value was read. ' +
            'There is no flag or environment variable that skips this prompt in this binding: the command ' +
            'came from a model, and the confirmation is the only control on it. ' +
            'Run the command yourself with `envseal run -- <command>` in a session that has a browser or a terminal.',
        });
      case 'busy':
        throw new SepError({
          code: 'SEP_RATE_LIMITED',
          userMessage:
            'Another envseal confirmation is already open. Answer that one first, then call env_use again.',
        });
      case 'too-large':
        throw new SepError({
          code: 'SEP_FORMAT_INVALID',
          userMessage:
            'This command is too large to display in a confirmation dialog, and envseal will not ask ' +
            'anyone to approve something it cannot show them. Run it with fewer or shorter arguments.',
        });
    }
  };
}

/**
 * `onApprovalNeeded` for the Broker: PLAN.md §6.4 probe consent for
 * `env_verify` against a host that is not registry-allowlisted.
 *
 * Never throws. verifyKey() calls this per key inside a loop that builds
 * per-key results; throwing would abort the whole `env_verify` call, so a
 * missing surface would take down the verification of keys whose probes are
 * allowlisted and fine. Every non-approval returns false, which keeps the
 * existing fail-closed `probe_not_approved` outcome for that one key.
 */
export function createProbeApproval(
  surface: ConfirmSurface,
): NonNullable<BrokerOptions['onApprovalNeeded']> {
  return async (entry) => {
    const outcome = await ask(
      surface,
      CONFIRM_KEY_PROBE,
      `Approve sending ${entry.key} to a host that is not on envseal's allowlist? Nothing has been sent yet.`,
      probeConfirmationBody(entry),
    );
    return outcome === 'approved';
  };
}

/**
 * `probe_not_approved` on its own tells the caller nothing it can act on.
 * verify.ts (core) names the host; this adds what to do about it, in the one
 * place a binding can add it without reaching into core.
 */
export function annotateVerifyResults(results: VerifyResult[]): VerifyResult[] {
  return results.map((result) => {
    if (result.result !== 'probe_not_approved') {
      return result;
    }
    return {
      ...result,
      message:
        `${result.message}. This host is not on envseal's bundled allowlist and no approval for this ` +
        `exact probe is recorded, so the credential was NOT sent. Run \`envseal verify ${result.key}\` ` +
        'in an interactive terminal on a machine with access to this ' +
        'project to review the method, URL and header template and decide. The decision is recorded in ' +
        '.envseal/approvals.json and replayed without asking again, until the key, method, URL or header ' +
        'template changes.',
    };
  });
}
