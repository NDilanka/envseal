import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { asSecret } from '@envseal/protocol';
import type {
  Prompter,
  PromptRequest,
  PromptResponse,
  PromptKeyRequest,
  PromptKeyResult,
} from './types.js';

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(probe, [command], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

function runCapture(
  file: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stdin.on('error', () => {});
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
    child.once('error', () => resolve({ code: -1, stdout: '' }));
    child.once('exit', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8') }));
  });
}

function formatLabel(key: PromptKeyRequest): string {
  let lines = key.key;
  if (key.description) {
    lines += `\n\n${key.description}`;
  }
  if (key.formatHint) {
    lines += `\n\nHint: ${key.formatHint}`;
  }
  return lines;
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

interface NativeAdapter {
  readonly name: string;
  available(): Promise<boolean>;
  promptOne(key: PromptKeyRequest, nonce: string): Promise<{
    outcome: 'entered' | 'cancelled' | 'skipped';
    value?: string;
  }>;
}

const macAdapter: NativeAdapter = {
  name: 'osascript',
  async available() {
    return commandExists('osascript');
  },
  async promptOne(key, nonce) {
    const label = escapeAppleScript(`${formatLabel(key)}\n\nNonce: ${nonce}`);
    // Passed on stdin (`osascript -`), never argv, so the prompt does not land in `ps`.
    const script =
      `set answer to text returned of (display dialog "${label}" ` +
      `default answer "" with hidden answer)\nreturn answer\n`;
    const { code, stdout } = await runCapture('osascript', ['-'], script);
    if (code !== 0 || stdout === '') {
      return { outcome: 'cancelled' };
    }
    const value = stdout.replace(/\r?\n$/, '');
    return { outcome: 'entered', value };
  },
};

const winAdapter: NativeAdapter = {
  name: 'powershell',
  async available() {
    return commandExists('powershell');
  },
  async promptOne(key, nonce) {
    const psScript =
      `$ErrorActionPreference = 'Stop'\n` +
      `$prompt = @'\n${formatLabel(key)}\n\nNonce: ${nonce}\n'@\n` +
      `$secure = Read-Host -Prompt $prompt -AsSecureString\n` +
      `if ($null -eq $secure) { exit 1 }\n` +
      `$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)\n` +
      `try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }\n` +
      `finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }\n`;
    // The prompt and whatever the user types live in a 0600 temp file, never argv.
    const tmpPath = join(tmpdir(), `envseal-${randomBytes(8).toString('hex')}.ps1`);
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeSync(fd, psScript, null, 'utf8');
    } finally {
      closeSync(fd);
    }
    try {
      const { code, stdout } = await runCapture(
        'powershell',
        ['-NoProfile', '-NonInteractive:$false', '-ExecutionPolicy', 'Bypass', '-File', tmpPath],
      );
      if (code !== 0 || stdout === '') {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'entered', value: stdout.replace(/\r?\n$/, '') };
    } finally {
      unlinkSync(tmpPath);
    }
  },
};

class LinuxAdapter implements NativeAdapter {
  readonly name: string = 'zenity/kdialog/ssh-askpass';
  private _tool: 'zenity' | 'kdialog' | 'ssh-askpass' | null = null;

  async available(): Promise<boolean> {
    if (this._tool !== null) {
      return true;
    }
    for (const candidate of ['zenity', 'kdialog', 'ssh-askpass'] as const) {
      if (await commandExists(candidate)) {
        this._tool = candidate;
        return true;
      }
    }
    return false;
  }

  async promptOne(
    key: PromptKeyRequest,
    nonce: string,
  ): Promise<{ outcome: 'entered' | 'cancelled' | 'skipped'; value?: string }> {
    if (this._tool === null) {
      await this.available();
    }
    const label = `${formatLabel(key)}\n\nNonce: ${nonce}`;
    switch (this._tool) {
      case 'zenity': {
        const { code, stdout } = await runCapture('zenity', ['--password', '--text', label]);
        if (code !== 0 || stdout === '') {
          return { outcome: 'cancelled' };
        }
        return { outcome: 'entered', value: stdout.replace(/\r?\n$/, '') };
      }
      case 'kdialog': {
        const { code, stdout } = await runCapture('kdialog', ['--password', label]);
        if (code !== 0 || stdout === '') {
          return { outcome: 'cancelled' };
        }
        return { outcome: 'entered', value: stdout.replace(/\r?\n$/, '') };
      }
      case 'ssh-askpass': {
        // Prompt goes to stdin, keeping it out of argv.
        const { code, stdout } = await runCapture('ssh-askpass', [], label);
        if (code !== 0 || stdout === '') {
          return { outcome: 'cancelled' };
        }
        const value = stdout
          .replace(/\r?\n$/, '')
          .replace(new RegExp(`^${regexEscape(label)}\n?`), '');
        return { outcome: 'entered', value };
      }
      default:
        return { outcome: 'cancelled' };
    }
  }
}

const linuxAdapter = new LinuxAdapter();

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class NativePrompter implements Prompter {
  readonly id: 'native-dialog' = 'native-dialog';

  private adapter(): NativeAdapter {
    if (process.platform === 'darwin') {
      return macAdapter;
    }
    if (process.platform === 'win32') {
      return winAdapter;
    }
    return linuxAdapter;
  }

  async available(): Promise<boolean> {
    return this.adapter().available();
  }

  async cancel(_ticket: string): Promise<void> {
    // Native dialogs are short-lived; there is nothing to cancel once spawned.
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    const adapter = this.adapter();
    const results: PromptKeyResult[] = [];
    for (const key of req.keys) {
      const answer = await adapter.promptOne(key, req.nonce);
      if (answer.outcome === 'cancelled') {
        results.push({ key: key.key, outcome: 'cancelled' });
        for (const rest of req.keys.slice(results.length)) {
          results.push({ key: rest.key, outcome: 'cancelled' });
        }
        break;
      }
      if (answer.outcome === 'skipped' || answer.value === undefined || answer.value === '') {
        results.push({ key: key.key, outcome: 'skipped' });
        continue;
      }
      results.push({ key: key.key, outcome: 'entered', value: asSecret(Buffer.from(answer.value, 'utf8')) });
    }
    return { ticket: req.ticket, results };
  }
}