// NOTE: This is NOT the default surface. Opening the controlling TTY collides
// with a harness's full-screen TUI repainting (PLAN.md §5.3). It is only
// selected explicitly, or as the last usable fallback when allowed.

import { openSync, writeSync, closeSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { spawn } from 'node:child_process';
import { asSecret } from '@envseal/protocol';
import type {
  Prompter,
  PromptRequest,
  PromptResponse,
  PromptKeyRequest,
  PromptKeyResult,
} from './types.js';

const POSIX_DEVICE = '/dev/tty';
const WIN_IN = 'CONIN$';
const WIN_OUT = 'CONOUT$';


function isPosix(): boolean {
  return process.platform !== 'win32';
}

function readLineRaw(inStream: ReadStream, outFd: number, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    writeSync(outFd, `${prompt}: `);
    let buffer = '';
    let done = false;
    const settle = (value: string, err?: Error): void => {
      if (done) {
        return;
      }
      done = true;
      process.removeListener('SIGINT', onSigint);
      inStream.removeListener('data', onData);
      inStream.removeListener('error', onError);
      if (err !== undefined) {
        reject(err);
      } else {
        resolve(value);
      }
    };
    const onSigint = (): void => {
      settle('');
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const at = text.search(/[\r\n]/);
      if (at !== -1) {
        settle(buffer + text.slice(0, at));
        return;
      }
      buffer += text;
    };
    const onError = (err: Error): void => {
      settle('', err);
    };
    process.once('SIGINT', onSigint);
    inStream.on('data', onData);
    inStream.on('error', onError);
  });
}

function winConsoleScript(enableEcho: boolean): string {
  const setMode = enableEcho
    ? '($m -bor 4)'
    : '($m -band (-bnot 4))';
  return (
    "$sig='[DllImport(\"kernel32.dll\",SetLastError=$true)] public static extern bool " +
    'SetConsoleMode(IntPtr h,uint mode); [DllImport("kernel32.dll",SetLastError=$true)] ' +
    'public static extern bool GetConsoleMode(IntPtr h,[ref]uint mode); ' +
    '[DllImport("kernel32.dll",SetLastError=$true)] public static extern IntPtr GetStdHandle(int n);\'; ' +
    'Add-Type -Namespace EnvSeal -MemberDefinition $sig -Name Native; ' +
    '$h=[EnvSeal.Native]::GetStdHandle(-10); ' +
    '[uint32]$m=0; ' +
    '[void][EnvSeal.Native]::GetConsoleMode($h,[ref]$m); ' +
    `[void][EnvSeal.Native]::SetConsoleMode($h,${setMode}); `
  );
}

/** Toggle echo on the console input buffer shared by this process (SetConsoleMode). */
function setWinConinEcho(enabled: boolean): Promise<void> {
  const encoded = Buffer.from(winConsoleScript(enabled), 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`SetConsoleMode failed with exit code ${code}`));
      }
    });
  });
}

export class TtyPrompter implements Prompter {
  readonly id = 'tty' as const;

  async available(): Promise<boolean> {
    try {
      const fd = this.openReadFd();
      new ReadStream(fd).destroy();
      return true;
    } catch {
      return false;
    }
  }

  private openReadFd(): number {
    return isPosix() ? openSync(POSIX_DEVICE, 'r+') : openSync(WIN_IN, 'r');
  }

  private openWriteFd(readFd: number): number {
    return isPosix() ? readFd : openSync(WIN_OUT, 'w');
  }

  async cancel(_ticket: string): Promise<void> {
    // A raw read is interrupted from the reading side (SIGINT or device close).
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    const results: PromptKeyResult[] = [];
    const readFd = this.openReadFd();
    const writeFd = this.openWriteFd(readFd);
    const inStream = new ReadStream(readFd);
    let modeChanged = false;
    try {
      if (isPosix()) {
        inStream.setRawMode(true);
        modeChanged = true;
      } else {
        await setWinConinEcho(false);
        modeChanged = true;
      }
      for (const key of req.keys) {
        const line = await readLineRaw(inStream, writeFd, formatLabel(key));
        if (line === '') {
          results.push({ key: key.key, outcome: 'skipped' });
          continue;
        }
        results.push({ key: key.key, outcome: 'entered', value: asSecret(Buffer.from(line, 'utf8')) });
      }
    } finally {
      if (isPosix()) {
        if (modeChanged) {
          try {
            inStream.setRawMode(false);
          } catch {
            // stream already destroyed
          }
        }
      } else if (modeChanged) {
        try {
          await setWinConinEcho(true);
        } catch {
          // best-effort restore
        }
      }
      inStream.destroy();
      if (!isPosix()) {
        closeSync(writeFd);
      }
    }

    return { ticket: req.ticket, results };
  }
}

function formatLabel(key: PromptKeyRequest): string {
  let label = key.key;
  if (key.description) {
    label += ` (${key.description})`;
  }
  return label;
}