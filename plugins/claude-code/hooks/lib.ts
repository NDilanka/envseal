import { stdin, stdout } from 'node:process';

/**
 * Shared stdin/stdout plumbing for all hooks. Hooks are bundled standalone
 * (no workspace build dependency) so this module intentionally has zero
 * imports beyond node builtins.
 */

export function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stdin.on('error', reject);
    // stdin may already be ended (no payload) in some harnesses.
    if (stdin.readableEnded) {
      resolve(Buffer.concat(chunks).toString('utf8'));
    }
  });
}

export function readPayload<T>(): Promise<T> {
  return readStdin().then((text) => {
    if (text.trim() === '') {
      return {} as T;
    }
    return JSON.parse(text) as T;
  });
}

export function writeResult(result: unknown): void {
  stdout.write(JSON.stringify(result));
}

export function writeError(message: string): void {
  stdout.write(JSON.stringify({ error: message }));
}
