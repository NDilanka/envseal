import { spawn } from 'node:child_process';
import type { SecretValue, ExecResult } from '@envseal/protocol';
import { SepError } from '@envseal/protocol';
import { redact } from './redact.js';
import { unsafeSecretToUtf8 } from './sinks/dotenv.js';

/**
 * Residual risk on Linux: A same-uid process can read /proc/<pid>/environ
 * of the child process. This cannot be defended against without sandboxing.
 * Users on shared systems should be aware of this limitation.
 */

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  onConfirm?: (info: { command: string[]; keys: string[]; networkEgress: boolean }) => Promise<boolean>;
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

  if (!isApproved && opts?.onConfirm) {
    const confirmed = await opts.onConfirm({
      command,
      keys: secretKeys,
      networkEgress,
    });

    if (!confirmed) {
      throw new SepError({
        code: 'SEP_CONFIRMATION_DENIED',
      });
    }
  } else if (!isApproved && !opts?.onConfirm) {
    throw new SepError({
      code: 'SEP_CONFIRMATION_DENIED',
    });
  }

  const childEnv = { ...process.env };
  const secretValues: SecretValue[] = [];

  for (const [key, value] of secrets) {
    const valueStr = unsafeSecretToUtf8(value);
    childEnv[key] = valueStr;
    secretValues.push(value);
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

      const redactStdout = redact(stdoutStr, secretValues);
      const redactStderr = redact(stderrStr, secretValues);

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
