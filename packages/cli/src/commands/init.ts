import { projectPaths, loadManifest, declareEntries } from '@envseal/core';
import { emit, fail } from '../output.js';
import { detectHost } from '../host.js';
import { scanForEnvKeys, entryForKey } from '../scan.js';

export async function init(
  root: string,
  json: boolean,
  hostOverride?: string,
): Promise<void> {
  try {
    const paths = projectPaths(root);
    const discovered = scanForEnvKeys(root);
    const entries = discovered.map(entryForKey);

    // declareEntries creates the manifest when absent and edits it surgically
    // when present, so re-running init on an existing project is safe and
    // preserves any descriptions the user has written by hand.
    const result = entries.length > 0 ? declareEntries(paths, entries) : { added: [], updated: [], unchanged: [] };
    const manifest = loadManifest(paths);

    const host = hostOverride
      ? { id: hostOverride, name: hostOverride, tier: 'C' as const, reason: 'specified with --host', recommendation: '' }
      : detectHost(root);

    const output = {
      manifestPath: paths.manifest,
      host: host.id,
      protectionTier: host.tier,
      scanned: discovered.length,
      added: result.added,
      updated: result.updated,
      unchanged: result.unchanged,
      secretKeys: discovered.filter((d) => d.secret).map((d) => d.key),
      configKeys: discovered.filter((d) => !d.secret).map((d) => d.key),
      entries: manifest?.entries.length ?? 0,
    };

    if (json) {
      emit(json, '', output);
      return;
    }

    if (discovered.length === 0) {
      console.log('No environment variables found in this project.');
      console.log(`Created an empty manifest at ${paths.manifest}.`);
      console.log('Add entries with `envseal set <KEY>` or let your agent call env_declare.');
    } else {
      console.log(`✓ Manifest written to ${paths.manifest}`);
      console.log(`  Found ${discovered.length} variable(s): ${result.added.length} added, ${result.unchanged.length} unchanged`);
      const secrets = discovered.filter((d) => d.secret);
      if (secrets.length > 0) {
        console.log(`  Secrets: ${secrets.map((s) => s.key).join(', ')}`);
      }
      const config = discovered.filter((d) => !d.secret);
      if (config.length > 0) {
        console.log(`  Config (not prompted): ${config.map((s) => s.key).join(', ')}`);
      }
    }
    console.log(`  Host: ${host.name} (protection tier ${host.tier})`);
    if (host.recommendation) console.log(`  ${host.recommendation}`);
  } catch (error) {
    fail(json, error);
  }
}
