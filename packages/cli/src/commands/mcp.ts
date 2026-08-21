import { spawnSync } from 'node:child_process';
import { finish } from '../exit.js';

export async function mcp(root: string): Promise<void> {
  // Delegate to the mcp-server binary
  const result = spawnSync('envseal-mcp', ['--project', root], {
    stdio: 'inherit',
  });

  finish(result.status ?? 0);
}
