import { spawn } from 'node:child_process';
import { SepError } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from '../paths.js';
import type { Sink } from './types.js';

/**
 * Machinery shared by sinks that store secrets through an external provider
 * CLI (vault, op, doppler, sops). The base owns what must behave identically
 * across all four — presence probing, exec with timeout and stderr capture,
 * exit-code-to-SepError mapping — so each adapter only translates its tool's
 * verbs and documented exit codes.
 *
 * Posture inherited by every subclass:
 * - values travel through stdin (the `input` option), never argv, where any
 *   process listing can read them;
 * - no path here ever logs, wraps, or stringifies a value;
 * - read() reports absence as null and remove() as false — via each tool's
 *   documented "not found" exit code, which only the adapter knows — while
 *   every other failure is a loud SepError; silence is reserved for genuine
 *   absence;
 * - a missing provider CLI degrades available() to false and never throws at
 *   import or construction time.
 *
 * No per-platform hook surface ships here on purpose: none of the four CLIs
 * needs platform-specific invocation today, and when one does, branch on
 * process.platform inside the adapter exactly as keychain.ts does.
 */

/**
 * A provider CLI that sits silent is usually sitting on an interactive login
 * or passphrase prompt this non-interactive pipe can never answer. Kill it
 * rather than holding the broker open forever.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CliExecResult {
  stdout: string;
  stderr: string;
}

export interface CliExecOptions {
  /**
   * Stdin payload. This is the ONLY sanctioned route for secret bytes: argv
   * is world-readable via ps/process listings, an inherited pipe is not.
   */
  input?: string;

  /**
   * Complete environment for the child (undefined values drop the variable).
   * Omit to inherit process.env unchanged. This REPLACES the environment
   * rather than merging — copy process.env explicitly when adding variables,
   * the way keychain.ts scrubs PSModulePath.
   */
  env?: Record<string, string | undefined>;

  timeoutMs?: number;
}

/**
 * A provider CLI ran and refused: nonzero exit, spawn failure, or timeout.
 * The exit code rides on the error because several tools document specific
 * codes as "item absent" — the adapter, not this base, decides which codes
 * mean absence for read()/remove() and which are real failures.
 */
export class CliCommandFailure extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'CliCommandFailure';
  }
}

export function exitCodeOf(error: unknown): number | undefined {
  return error instanceof CliCommandFailure
    ? error.exitCode
    : (error as { exitCode?: number } | null)?.exitCode;
}

/** First stderr line, truncated: enough to diagnose, small enough for a dialog. */
function firstStderrLine(stderr: string): string {
  const first = stderr.trimStart().split(/\r?\n/, 1)[0];
  if (first === undefined || first.length === 0) return '';
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

/** Same probe keychain.ts uses; `where`/`which` exit nonzero when absent. */
export function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return new Promise<boolean>((resolve) => {
    const proc = spawn(checker, [command], { shell: false, stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

export function execCli(
  command: string,
  args: string[],
  options: CliExecOptions = {},
): Promise<CliExecResult> {
  return new Promise<CliExecResult>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const proc = spawn(command, args, {
      shell: false,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(options.env ? { env: options.env } : {}),
    });

    const beginSettle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      // Settle BEFORE killing: the killed child's 'close' must never overwrite
      // the timeout verdict with a spurious nonzero-exit error.
      if (beginSettle()) {
        reject(
          new CliCommandFailure(
            `${command} produced no output within ${timeoutMs}ms — it is likely waiting on an interactive prompt this channel cannot answer`,
            command,
            undefined,
            stderr,
          ),
        );
      }
      proc.kill();
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    proc.on('error', (err) => {
      if (beginSettle()) reject(err);
    });

    proc.on('close', (code) => {
      if (!beginSettle()) return;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      // Callers distinguish "item absent" (a documented exit code per tool)
      // from real failures, so the code rides on the error itself.
      const line = firstStderrLine(stderr);
      reject(
        new CliCommandFailure(
          line ? `${command} exited with code ${code}: ${line}` : `${command} exited with code ${code}`,
          command,
          code ?? undefined,
          stderr,
        ),
      );
    });

    if (proc.stdin && options.input !== undefined) {
      // A child that dies mid-read raises EPIPE on our stdin end; swallow it —
      // the real verdict arrives via 'close' or 'error'.
      proc.stdin.on('error', () => {});
      proc.stdin.write(options.input);
      proc.stdin.end();
    }
  });
}

export type CliSinkOperation = 'read' | 'write' | 'remove';

export abstract class CliSinkBase implements Sink {
  abstract readonly id: string;

  /**
   * External CLIs this sink shells out to, probed in order. List every binary
   * an operation spawns, not configuration: VAULT_ADDR-style settings are
   * validated at operation time, where a bad value can produce a precise
   * message instead of a vague "not installed".
   */
  protected abstract readonly requiredCommands: readonly string[];

  /**
   * What is missing, phrased for the user — e.g. "the vault CLI is not
   * installed or VAULT_ADDR is unset". Feeds both the SEP_SINK_UNAVAILABLE
   * thrown when a listed command is missing at operation time and the stub
   * refusals below, until an implementing agent fills the operations in.
   */
  protected abstract unavailableReason(): string;

  async available(_paths: ProjectPaths): Promise<boolean> {
    return (await this.firstMissingCommand()) === null;
  }

  async read(_paths: ProjectPaths, _key: string): Promise<SecretValue | null> {
    throw this.stubFailure('read');
  }

  async write(_paths: ProjectPaths, _key: string, _value: SecretValue): Promise<void> {
    throw this.stubFailure('write');
  }

  async remove(_paths: ProjectPaths, _key: string): Promise<boolean> {
    throw this.stubFailure('remove');
  }

  /**
   * Probe requiredCommands and turn a miss into SEP_SINK_UNAVAILABLE. Every
   * real operation starts here: available() may have been consulted long
   * before, and the CLI can vanish in between.
   */
  protected async requirePrerequisites(): Promise<void> {
    if ((await this.firstMissingCommand()) !== null) throw this.unavailableError();
  }

  /**
   * Default mapping of a raw CLI failure onto the protocol surface. The
   * protocol has no read/remove-specific code, so WRITE_FAILED — the generic
   * "sink operation failed" surface, and retriable, which fits how most of
   * these failures clear (expired session, unreachable host) — is the default
   * for every operation. Adapters override this where their tool argues for
   * something sharper.
   *
   * Provider stderr stays in details only: it is diagnostics, and no
   * user-facing message should repeat output we do not control.
   */
  protected sinkFailure(operation: CliSinkOperation, error: unknown, key?: string): SepError {
    if (error instanceof SepError) return error;
    const target = key === undefined ? '' : ` ${key}`;

    // The binary vanished between the prerequisite probe and the spawn; that
    // is unavailability, not a failed operation.
    if ((error as { code?: string } | null)?.code === 'ENOENT') {
      return this.unavailableError();
    }

    if (error instanceof CliCommandFailure) {
      return new SepError({
        code: 'SEP_SINK_WRITE_FAILED',
        userMessage: `Could not ${operation}${target} via ${this.id}: ${error.command} failed with exit code ${error.exitCode ?? 'unknown'}.`,
        details: {
          sink: this.id,
          operation,
          command: error.command,
          exitCode: error.exitCode ?? null,
          stderr: error.stderr.slice(0, 400),
        },
      });
    }

    return new SepError({
      code: 'SEP_SINK_WRITE_FAILED',
      userMessage: `Could not ${operation}${target} via ${this.id}: unexpected error.`,
      details: { sink: this.id, operation },
    });
  }

  private async firstMissingCommand(): Promise<string | null> {
    for (const command of this.requiredCommands) {
      if (!(await commandExists(command))) return command;
    }
    return null;
  }

  private unavailableError(): SepError {
    return new SepError({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: `The ${this.id} sink is not available — ${this.unavailableReason()}.`,
    });
  }

  /**
   * Body of every operation until an implementing agent overrides it. The
   * parenthetical stays even after the other operations land: a forgotten
   * override must announce itself, not masquerade as a missing CLI.
   */
  private stubFailure(operation: CliSinkOperation): SepError {
    return new SepError({
      code: 'SEP_SINK_UNAVAILABLE',
      userMessage: `The ${this.id} sink is not available — ${this.unavailableReason()} (${operation} not implemented yet).`,
    });
  }
}
