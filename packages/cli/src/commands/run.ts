import { emit, fail } from '../output.js';
import { createBroker } from '../cli-utils.js';

export async function run(
  root: string,
  command: string[],
  json: boolean,
): Promise<void> {
  try {
    const broker = await createBroker(root);
    const status = await broker.describe();

    // Get all present keys
    const presentKeys = status.entries
      .filter((e) => e.present)
      .map((e) => e.key);

    const result = await broker.use({
      keys: presentKeys,
      command,
    });

    if (!json) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    } else {
      emit(json, '', {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }

    process.exit(result.exitCode ?? 0);
  } catch (error) {
    fail(json, error);
  }
}
