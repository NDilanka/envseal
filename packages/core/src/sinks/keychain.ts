import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { asSecret } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from '../paths.js';
import { ensureStateDir } from '../paths.js';
import type { Sink } from './types.js';
import { unsafeSecretToUtf8 } from './dotenv.js';

function execCommand(
  file: string,
  args: string[],
  input?: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(file, args, {
      shell: false,
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

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

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${file} exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    if (input && proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

async function checkCommandAvailable(cmd: string): Promise<boolean> {
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? 'where' : 'which';
    await execCommand(checkCmd, [cmd]);
    return true;
  } catch {
    return false;
  }
}

class KeychainSink implements Sink {
  readonly id = 'keychain';

  async available(): Promise<boolean> {
    if (process.platform === 'darwin') {
      return checkCommandAvailable('security');
    } else if (process.platform === 'win32') {
      return true;
    } else {
      return checkCommandAvailable('secret-tool');
    }
  }

  async read(): Promise<SecretValue | null> {
    return null;
  }

  async write(_paths: ProjectPaths, key: string, value: SecretValue): Promise<void> {
    const projectId = _paths.root.split(/[\\/]/).pop() ?? 'unknown';
    const account = `${projectId}:${key}`;
    const valueStr = unsafeSecretToUtf8(value);

    if (process.platform === 'darwin') {
      await execCommand('security', [
        'add-generic-password',
        '-U',
        '-s',
        'envseal',
        '-a',
        account,
        '-w',
        valueStr,
      ]);
    } else if (process.platform === 'win32') {
      const dir = join(homedir(), 'AppData', 'Local', 'envseal', 'creds');
      mkdirSync(dir, { recursive: true });

      const escapedPath = join(dir, key).replace(/\\/g, '\\\\');
      const script = `$value = [System.IO.File]::ReadAllText([System.Console]::In)\n$secure = ConvertTo-SecureString -String $value -AsPlainText -Force\n$encrypted = ConvertFrom-SecureString -SecureString $secure\n[System.IO.File]::WriteAllText('${escapedPath}', $encrypted)`;
      const scriptPath = join(dir, `${key}.ps1`);
      writeFileSync(scriptPath, script);

      try {
        await execCommand('powershell', ['-NoProfile', '-File', scriptPath], valueStr);
      } finally {
        try {
          unlinkSync(scriptPath);
        } catch {
          // ignore
        }
      }
    } else {
      await execCommand('secret-tool', ['store', '--label=envseal', 'service', 'envseal', 'account', account], valueStr);
    }
  }

  async remove(): Promise<boolean> {
    return false;
  }
}

export const keychainSink = new KeychainSink();
