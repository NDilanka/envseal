import { projectPaths, loadManifest, declareEntries } from '@envseal/core';
import { emit, fail } from '../output.js';
import { detectHost } from '../host.js';
import { scanForEnvKeys, entryForKey } from '../scan.js';
import { EXIT } from '../exit-codes.js';
import { finish } from '../exit.js';

// The ids detectHost can ever return. --host used to accept any string
// silently, recording a host detection would never report and printing a tier
// computed for a fiction.
const KNOWN_HOST_IDS = ['claude-code', 'cursor', 'continue', 'aider', 'generic', 'unknown'];

export async function init(
  root: string,
  json: boolean,
  hostOverride?: string,
): Promise<void> {
  try {
    if (hostOverride !== undefined && !KNOWN_HOST_IDS.includes(hostOverride)) {
      console.error(
        `Error: unknown --host '${hostOverride}'. Valid values: ${KNOWN_HOST_IDS.join(', ')}.`,
      );
      finish(EXIT.USAGE);
      return;
    }

    const paths = projectPaths(root);
    const discovered = scanForEnvKeys(root);
    const entries = discovered.map(entryForKey);

    // declareEntries creates the manifest when absent and edits it surgically
    // when present, so re-running init on an existing project is safe and
    // preserves any descriptions the user has written by hand. It runs even
    // when the scan finds nothing: the "created an empty manifest" message
    // below must be true, not aspirational.
    const result = declareEntries(paths, entries);
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
    if (hostOverride) {
      // The override line above is what was ASKED for, not what is here. An
      // auto-detected init on the same project can print a different tier, and
      // doctor is the one that reports evidence.
      console.log('  Override recorded; envseal doctor reports what is actually detected.');
    }
    if (host.id === 'claude-code') {
      // Without this the first run ends at a manifest and no connection: init
      // writes env.schema.jsonc but nothing tells the user the agent still has
      // to be pointed at the broker.
      console.log('');
      console.log('Connect your agent: create .mcp.json in the project root containing');
      console.log('  {"mcpServers":{"envseal-mcp":{"command":"envseal-mcp","args":[]}}}');
      console.log(
        'then restart Claude Code — or install plugins/claude-code for Tier A hooks.',
      );
    }
  } catch (error) {
    fail(json, error);
  }
}
