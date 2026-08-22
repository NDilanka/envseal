import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { asSecret } from '@envseal/protocol';
import type { SecretValue } from '@envseal/protocol';
import type { ProjectPaths } from '../paths.js';
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
        // Callers distinguish "item absent" (a documented exit code per tool)
        // from real failures, so the code rides on the error itself.
        const err = new Error(`${file} exited with code ${code}: ${stderr}`) as Error & {
          exitCode?: number;
        };
        err.exitCode = code ?? undefined;
        reject(err);
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

function exitCodeOf(error: unknown): number | undefined {
  return (error as { exitCode?: number } | null)?.exitCode;
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

// macOS `security` reports errSecItemNotFound as exit 44; secret-tool exits 1
// when lookup/clear finds nothing. Both mean ABSENCE, which read()/remove()
// must report as null/false rather than a thrown failure.
const MACOS_ITEM_NOT_FOUND = 44;
const SECRET_TOOL_NOT_FOUND = 1;

/**
 * The account name write() filed this key under. mac/linux scope entries by
 * `<projectId>:<key>`; the Windows blob path below stays keyed by <KEY> alone,
 * matching what write() has always written there.
 */
function accountFor(paths: ProjectPaths, key: string): string {
  const projectId = paths.root.split(/[\\/]/).pop() ?? 'unknown';
  return `${projectId}:${key}`;
}

/** The directory holding the DPAPI blobs, exactly where write() puts them. */
function windowsCredsDir(): string {
  return join(homedir(), 'AppData', 'Local', 'envseal', 'creds');
}

/**
 * Editors and shells export a PSModulePath that leads with PowerShell 7 module
 * dirs; those shadow 5.1's Security module (duplicate type data) and
 * ConvertTo-SecureString silently vanishes. Dropping the variable makes 5.1
 * rebuild its own defaults.
 *
 * Every CASING must go: some launchers (pnpm on Windows among them) rewrite
 * the name as PSMODULEPATH, and an exact-case destructure then leaves the
 * uppercased twin behind — the child inherits the poisoned path anyway.
 */
function childEnvWithoutPSModulePath(): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^psmodulepath$/i.test(name)) continue;
    childEnv[name] = value;
  }
  return childEnv;
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

  async read(paths: ProjectPaths, key: string): Promise<SecretValue | null> {
    if (process.platform === 'darwin') {
      try {
        const stdout = await execCommand('security', [
          'find-generic-password',
          '-s',
          'envseal',
          '-a',
          accountFor(paths, key),
          '-w',
        ]);
        // security prints the password followed by one newline.
        return asSecret(Buffer.from(stdout.replace(/\n$/, ''), 'utf8'));
      } catch (error) {
        if (exitCodeOf(error) === MACOS_ITEM_NOT_FOUND) return null;
        throw error;
      }
    }

    if (process.platform === 'win32') {
      return this.readWindows(key);
    }

    try {
      const stdout = await execCommand('secret-tool', [
        'lookup',
        'service',
        'envseal',
        'account',
        accountFor(paths, key),
      ]);
      // secret-tool exits 0 with empty output when the lookup misses.
      if (stdout.length === 0) return null;
      return asSecret(Buffer.from(stdout.replace(/\n$/, ''), 'utf8'));
    } catch (error) {
      if (exitCodeOf(error) === SECRET_TOOL_NOT_FOUND) return null;
      throw error;
    }
  }

  /**
   * Decrypt the DPAPI blob write() left at creds\<KEY>. Absent file means the
   * value is not stored (null); anything present-but-unreadable is a loud
   * error, never a silent null — a corrupt blob pretending to be "absent"
   * would send ensure() back to the prompt instead of telling the user their
   * credential store needs attention.
   */
  private async readWindows(key: string): Promise<SecretValue | null> {
    const dir = windowsCredsDir();
    const blobPath = join(dir, key);

    let blob: string;
    try {
      blob = readFileSync(blobPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    // A 0-byte file is exactly the silent-write failure the write path guards
    // against; refuse it before the hex check can pass on empty input.
    if (blob.trim().length === 0) {
      throw new Error(`Keychain blob for ${key} is empty (${blobPath})`);
    }
    // ConvertFrom-SecureString emits hex digits only; anything else is not a
    // blob this sink wrote.
    if (!/^[0-9a-f]+$/i.test(blob.trim())) {
      throw new Error(`Keychain blob for ${key} is not a hex DPAPI blob (${blobPath})`);
    }

    // The decrypt snippet goes through a temp script file, never argv, where it
    // would be visible to any process listing.
    const escapedPath = blobPath.replace(/\\/g, '\\\\');
    const scriptPath = join(dir, `${key}.read.ps1`);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$blob = Get-Content -Raw '${escapedPath}'`,
      '$secure = ConvertTo-SecureString -String $blob',
      '$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
      'try {',
      '  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)',
      '} finally {',
      '  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)',
      '}',
      '[Console]::Out.Write($plain)',
      '',
    ].join('\n');
    writeFileSync(scriptPath, script);

    // Same scrub write() does: a PSModulePath inherited from an editor leads
    // with PowerShell 7 module dirs and breaks the Security module under 5.1.
    const childEnv = childEnvWithoutPSModulePath();

    try {
      const stdout = await execCommand(
        'powershell',
        ['-NoProfile', '-File', scriptPath],
        undefined,
        childEnv,
      );
      // [Console]::Out.Write emits the plaintext verbatim; trimming here would
      // corrupt a value that genuinely ends in whitespace.
      return asSecret(Buffer.from(stdout, 'utf8'));
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {
        // ignore
      }
    }
  }

  async write(_paths: ProjectPaths, key: string, value: SecretValue): Promise<void> {
    const account = accountFor(_paths, key);
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
      const dir = windowsCredsDir();
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

      const childEnv = childEnvWithoutPSModulePath();

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
      await execCommand(
        'secret-tool',
        ['store', '--label=envseal', 'service', 'envseal', 'account', account],
        valueStr,
      );
    }
  }

  async remove(paths: ProjectPaths, key: string): Promise<boolean> {
    if (process.platform === 'darwin') {
      try {
        await execCommand('security', [
          'delete-generic-password',
          '-s',
          'envseal',
          '-a',
          accountFor(paths, key),
        ]);
        return true;
      } catch (error) {
        if (exitCodeOf(error) === MACOS_ITEM_NOT_FOUND) return false;
        throw error;
      }
    }

    if (process.platform === 'win32') {
      try {
        unlinkSync(join(windowsCredsDir(), key));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }

    try {
      await execCommand('secret-tool', ['clear', 'service', 'envseal', 'account', accountFor(paths, key)]);
      return true;
    } catch (error) {
      if (exitCodeOf(error) === SECRET_TOOL_NOT_FOUND) return false;
      throw error;
    }
  }
}

export const keychainSink = new KeychainSink();
