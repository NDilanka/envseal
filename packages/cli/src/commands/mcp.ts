import { spawnSync } from 'node:child_process';
import { EXIT } from '../exit-codes.js';
import { finish } from '../exit.js';

export async function mcp(root: string): Promise<void> {
  // Delegate to the mcp-server binary
  const result = spawnSync('envseal-mcp', ['--project', root], {
    stdio: 'inherit',
  });

  // A spawn failure leaves `status` null AND populates `error`. The old
  // `result.status ?? 0` turned "the server binary does not exist / cannot be
  // executed" into exit 0 — a host wiring this command saw silent success while
  // nothing was serving. Report it honestly instead.
  if (result.error || result.status === null) {
    const reason =
      result.error?.message ?? 'the envseal-mcp binary could not be executed';
    console.error(
      `Error: failed to start the envseal MCP server (is @envseal/mcp-server installed?): ${reason}`,
    );
    finish(EXIT.SINK_FAILURE);
    return;
  }

  finish(result.status);
}
