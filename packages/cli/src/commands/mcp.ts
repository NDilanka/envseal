import { spawnSync } from 'node:child_process';

export async function mcp(root: string): Promise<void> {
  // Delegate to the mcp-server binary
  const result = spawnSync('envseal-mcp', ['--project', root], {
    stdio: 'inherit',
  });

  process.exit(result.status ?? 0);
}
