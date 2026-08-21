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
  env?: Record<string, string | undefined>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(file, args, {
      shell: false,
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
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
      // @($input), not [System.Console]::In: the PowerShell console host reads
      // an empty string from a spawned pipe's stdin. The empty checks exit 1 so
      // that can never again become a silent 0-byte blob.
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$value = @($input) -join "`n"',
        'if (-not $value) { exit 1 }',
        '$secure = ConvertTo-SecureString -String $value -AsPlainText -Force',
        '$encrypted = ConvertFrom-SecureString -SecureString $secure',
        'if (-not $encrypted) { exit 1 }',
        `[System.IO.File]::WriteAllText('${escapedPath}', $encrypted)`,
      ].join('\n');
      const scriptPath = join(dir, `${key}.ps1`);
      writeFileSync(scriptPath, script);

      // Editors and shells export a PSModulePath that leads with PowerShell 7
      // module dirs; those shadow 5.1's Security module (duplicate type data)
      // and ConvertTo-SecureString silently vanishes. Dropping the variable
      // makes 5.1 rebuild its own defaults.
      const { PSModulePath: _shadowed, ...childEnv } = process.env;

      try {
        await execCommand('powershell', ['-NoProfile', '-File', scriptPath], valueStr, childEnv);
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
