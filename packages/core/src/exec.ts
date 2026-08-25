import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { SecretValue, ExecResult } from '@envseal/protocol';
import { SepError } from '@envseal/protocol';
import { redact } from './redact.js';
import { unsafeSecretToUtf8 } from './sinks/dotenv.js';

/**
 * Residual risk on Linux: A same-uid process can read /proc/<pid>/environ
 * of the child process. This cannot be defended against without sandboxing.
 * Users on shared systems should see this limitation.
 */

/**
 * One argument that named a readable file at approval time, bound to its
 * content. Repo scripts usually ride as arguments (`node ./build/x.mjs`,
 * `bash scripts/release.sh`), so consent must cover them, not just argv[0].
 */
export interface TargetFile {
  /** The argument exactly as it appeared in the command. */
  argument: string;
  /** Absolute path whose content was hashed. */
  resolvedPath: string;
  /** SHA-256 of the file content at approval time. */
  sha256: string;
}

/**
 * What the approver is told about the program they are approving. Consent for
 * `env_use` binds to this content, not to the displayed argument text: a repo
 * script named anywhere in argv can be rewritten while the approval dialog is
 * open, so the dialog shows content fingerprints and every named file is
 * re-checked immediately before spawn (see the T11 note below).
 */
export interface TargetInfo {
  /** Absolute resolution of argv[0]; often a PATH lookup, not a file. */
  resolvedPath: string;
  /**
   * SHA-256 of argv[0]'s own content when argv[0] names a readable file
   * (direct script invocation: `./scripts/release.sh`), else null
   * (PATH-resolved executables: `node`, `python`, ...).
   */
  sha256: string | null;
  /**
   * Every distinct argument that resolved to a readable file — including
   * argv[0] itself when it is one. Each entry is re-verified against fresh
   * disk content just before spawn; any change refuses with
   * SEP_TARGET_CHANGED.
   */
  hashedFiles: TargetFile[];
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  onConfirm?: (info: {
    command: string[];
    keys: string[];
    networkEgress: boolean;
    target: TargetInfo;
  }) => Promise<boolean>;
  approvedCommands?: string[];
}

const NETWORK_TOOLS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'rsync',
  'http',
  'httpie',
  'telnet',
  'socat',
]);

/** Nothing remotely path-shaped is longer than this on any supported OS. */
const MAX_PATHISH_CHARS = 4096;

function detectNetworkEgress(command: string[]): boolean {
  if (command.length === 0) {
    return false;
  }

  const basename = command[0]!.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (NETWORK_TOOLS.has(basename)) {
    return true;
  }

  for (const arg of command) {
    if (/^https?:\/\//.test(arg)) {
      return true;
    }
  }

  return false;
}

/**
 * T11 hardening: hash the files the command names, so approval binds to
 * content rather than to displayed text. Streaming read — a multi-gigabyte
 * argument must not be loaded into memory to be fingerprinted. Any read
 * failure yields null rather than throwing: unreadable targets fail later at
 * spawn with their own honest error, and refusing here would report a denial
 * nobody made.
 */
async function sha256File(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return null;
    }
    const hash = createHash('sha256');
    await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolveStream());
      stream.on('error', rejectStream);
    });
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Internal state captured at approval time and rebuilt just before spawn:
 * the content hash of every named file, plus the resolutions that were NOT
 * readable files (so a file materialising at one of those paths during the
 * approval window is caught too — the create-during-consent variant).
 */
interface FileSnapshot {
  files: Map<string, string>;
  pending: Set<string>;
}

async function snapshotNamedFiles(
  command: string[],
  cwd: string | undefined,
): Promise<{ info: TargetInfo; snapshot: FileSnapshot }> {
  const base = cwd ?? process.cwd();
  const files = new Map<string, string>();
  const pending = new Set<string>();
  let argv0Sha: string | null = null;
  let argv0Resolved = '';

  for (let index = 0; index < command.length; index += 1) {
    const arg = command[index]!;
    if (
      arg.length === 0 ||
      arg.length > MAX_PATHISH_CHARS ||
      // Scheme-shaped (https://..., file://...) — but NOT a Windows drive
      // path: `C:\repo\script.mjs` matches the naive scheme regex and must
      // stay hashable.
      (/^[a-z][a-z0-9+.-]*:/i.test(arg) && !/^[a-zA-Z]:(\\|\/)/.test(arg))
    ) {
      continue; // empty, impossibly long, or URL-shaped
    }
    const abs = resolvePath(base, arg);
    if (index === 0) {
      argv0Resolved = abs;
    }
    const sha = await sha256File(abs);
    if (sha !== null) {
      if (index === 0) {
        argv0Sha = sha;
      }
      files.set(abs, sha);
    } else if (!files.has(abs)) {
      pending.add(abs);
    }
  }

  const hashedFiles: TargetFile[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const abs = resolvePath(base, command[index]!);
    const sha = files.get(abs);
    if (sha !== undefined) {
      hashedFiles.push({ argument: command[index]!, resolvedPath: abs, sha256: sha });
    }
  }

  return {
    info: { resolvedPath: argv0Resolved, sha256: argv0Sha, hashedFiles },
    snapshot: { files, pending },
  };
}

function assertUnchanged(approved: FileSnapshot, current: FileSnapshot, samplePath: string): void {
  for (const [path, sha] of approved.files) {
    const now = current.files.get(path);
    if (now === null || now === undefined || now !== sha) {
      throw new SepError({
        code: 'SEP_TARGET_CHANGED',
        details: { target: path },
      });
    }
  }
  for (const path of approved.pending) {
    // Named but absent (or directory) at approval time; a readable file
    // appearing there before spawn means the command would execute content
    // nobody could approve.
    if (current.files.has(path)) {
      throw new SepError({
        code: 'SEP_TARGET_CHANGED',
        details: { target: path },
      });
    }
  }
  void samplePath;
}

export async function runWithSecrets(
  command: string[],
  secrets: Map<string, SecretValue>,
  opts?: ExecOptions,
): Promise<ExecResult> {
  if (command.length === 0) {
    throw new SepError({
      code: 'SEP_FORMAT_INVALID',
      userMessage: 'Command cannot be empty',
    });
  }

  const networkEgress = detectNetworkEgress(command);
  const secretKeys = Array.from(secrets.keys());
  const joinedCommand = command.join(' ');
  const isApproved = opts?.approvedCommands?.some((approved) => approved === joinedCommand);

  // The named files are fingerprinted twice: before the dialog is drawn (so
  // the user approves content fingerprints, not just a command line) and
  // again after consent, immediately before spawn. Content that changed in
  // between — the injected-content-mutates-a-repo-script window — refuses
  // with SEP_TARGET_CHANGED and nothing executes. The second read narrows
  // the race to microseconds; closing it entirely would need an fd handed to
  // the OS loader, which Node's spawn does not expose.
  const approvedSnapshot = await snapshotNamedFiles(command, opts?.cwd);

  if (!isApproved && opts?.onConfirm) {
    const confirmed = await opts.onConfirm({
      command,
      keys: secretKeys,
      networkEgress,
      target: approvedSnapshot.info,
    });

    if (!confirmed) {
      throw new SepError({
        code: 'SEP_CONFIRMATION_DENIED',
      });
    }

    const justBeforeSpawn = await snapshotNamedFiles(command, opts?.cwd);
    assertUnchanged(approvedSnapshot.snapshot, justBeforeSpawn.snapshot, approvedSnapshot.info.resolvedPath);
  } else if (!isApproved && !opts?.onConfirm) {
    throw new SepError({
      code: 'SEP_CONFIRMATION_DENIED',
    });
  }

  const childEnv = { ...process.env };
  const secretValues: SecretValue[] = [];
  // W2-F31: docs/cli-contract.md promises masks read
  // «redacted:KEY_NAME». Nothing but the key name rides along — redact()
  // rejects a label that is not a plain identifier, so a label can never carry
  // markup or a value fragment into the output stream.
  const redactionLabels = new Map<SecretValue, string>();

  for (const [key, value] of secrets) {
    const valueStr = unsafeSecretToUtf8(value);
    childEnv[key] = valueStr;
    secretValues.push(value);
    redactionLabels.set(value, key);
  }

  const MAX_BUFFER = 1024 * 1024;
  const proc = spawn(command[0]!, command.slice(1), {
    cwd: opts?.cwd,
    env: childEnv,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let exitCode: number | null = null;

  const stdoutListener = (chunk: Buffer) => {
    if (stdout.length < MAX_BUFFER) {
      stdout = Buffer.concat([stdout, chunk], Math.min(stdout.length + chunk.length, MAX_BUFFER));
    }
  };

  const stderrListener = (chunk: Buffer) => {
    if (stderr.length < MAX_BUFFER) {
      stderr = Buffer.concat([stderr, chunk], Math.min(stderr.length + chunk.length, MAX_BUFFER));
    }
  };

  proc.stdout?.on('data', stdoutListener);
  proc.stderr?.on('data', stderrListener);

  return new Promise<ExecResult>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      proc.stdout?.removeListener('data', stdoutListener);
      proc.stderr?.removeListener('data', stderrListener);
    };

    const finish = (code: number | null) => {
      cleanup();
      exitCode = code;

      const stdoutStr = stdout.toString('utf8');
      const stderrStr = stderr.toString('utf8');

      const redactStdout = redact(stdoutStr, secretValues, redactionLabels);
      const redactStderr = redact(stderrStr, secretValues, redactionLabels);

      resolve({
        exitCode,
        stdout: redactStdout.text,
        stderr: redactStderr.text,
        timedOut,
        redactedCount: redactStdout.count + redactStderr.count,
      });
    };

    proc.on('exit', (code) => {
      if (!timedOut) {
        finish(code);
      }
    });

    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });

    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (proc.exitCode === null) {
          timedOut = true;
          proc.kill('SIGTERM');

          setTimeout(() => {
            if (proc.exitCode === null) {
              proc.kill('SIGKILL');
            }
            finish(null);
          }, 1000);
        }
      }, opts.timeoutMs);

      timeoutHandle.unref();
    }
  });
}
