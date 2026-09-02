import { projectPaths, loadManifest, declareEntries, scanManifestEntry } from '@envseal/core';
import { SepError } from '@envseal/protocol';
import { emit, fail } from '../output.js';
import { detectHost, resolveInitHostIds } from '../host.js';
import { scanForEnvKeys, entryForKey } from '../scan.js';
import { EXIT } from '../exit-codes.js';
import { finish } from '../exit.js';
import { applyHostWiring } from '../host-wiring/apply.js';

export async function init(
  root: string,
  json: boolean,
  hostOverride?: string,
): Promise<void> {
  try {
    const resolved = resolveInitHostIds(root, hostOverride);
    if (resolved.error !== undefined) {
      console.error(`Error: ${resolved.error}`);
      finish(EXIT.USAGE);
      return;
    }

    const paths = projectPaths(root);
    const discovered = scanForEnvKeys(root);

    // F1: a manifest that already exists was authored by someone else (an
    // editor, another tool, a malicious repo). Declaring into it without
    // validating it first would launder hostile entries — e.g. a
    // secret-shaped format.example — through envseal's own write path and
    // commit them as blessed. Re-run the same schema+guard validation the
    // declare path uses over every entry already on disk.
    const existing = loadManifest(paths);
    if (existing !== null) {
      for (const [index, entry] of existing.entries.entries()) {
        const finding = scanManifestEntry(entry, `entries[${index}]`);
        if (finding !== null) {
          throw new SepError({
            code: 'SEP_VALUE_IN_REQUEST',
            details: { field: finding.path },
            userMessage:
              `Refusing to init: the existing ${finding.path} entry looks like it contains a real credential (${finding.label}). ` +
              'Manifest fields are committed to git and must describe keys, never contain values.',
          });
        }
      }
    }
    const entries = discovered.map(entryForKey);

    // declareEntries creates the manifest when absent and edits it surgically
    // when present, so re-running init on an existing project is safe and
    // preserves any descriptions the user has written by hand. It runs even
    // when the scan finds nothing: the "created an empty manifest" message
    // below must be true, not aspirational.
    const result = declareEntries(paths, entries);
    const manifest = loadManifest(paths);

    const wiring = applyHostWiring(root, resolved.ids);
    // Evidence after write: --host cursor on a bare tree now has `.cursor/`.
    // Never invent a fake tier from the flag alone.
    const detected = detectHost(root);
    const cursorEntry = wiring.hosts.find((h) => h.id === 'cursor');
    const cursorWiring = wiring.cursor;

    const output = {
      manifestPath: paths.manifest,
      host: detected.id,
      protectionTier: detected.tier,
      requestedHosts: resolved.source === 'flag' ? resolved.ids : undefined,
      wiredHosts: resolved.ids,
      wiringSource: resolved.source,
      scanned: discovered.length,
      added: result.added,
      updated: result.updated,
      unchanged: result.unchanged,
      secretKeys: discovered.filter((d) => d.secret).map((d) => d.key),
      configKeys: discovered.filter((d) => !d.secret).map((d) => d.key),
      entries: manifest?.entries.length ?? 0,
      agentsMd: {
        action: wiring.agentsMd.action,
        path: wiring.agentsMd.path,
      },
      hostWiring: wiring.hosts.map((h) => ({
        id: h.id,
        action: h.action,
        path: h.path,
      })),
      ...(cursorWiring === undefined
        ? {}
        : {
            cursorWiring: {
              mcp: cursorWiring.mcp,
              rules: cursorWiring.rules,
              mcpPath: cursorWiring.mcpPath,
              rulesPath: cursorWiring.rulesPath,
            },
          }),
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

    console.log(`  AGENTS.md: ${wiring.agentsMd.action} (Layer 1 — envseal ensure / envseal run --)`);
    console.log(`  Detected host: ${detected.name} (protection tier ${detected.tier})`);
    console.log(`    ${detected.reason}`);
    if (detected.recommendation) console.log(`    ${detected.recommendation}`);
    if (resolved.source === 'flag') {
      console.log(
        `  Requested host(s): ${resolved.ids.join(', ')}. Override recorded; envseal doctor reports what is actually detected.`,
      );
    }
    if (resolved.source === 'none') {
      console.log('  No project host markers and this process is not an IDE.');
      console.log('  Wrote AGENTS.md only. Re-run from the IDE, or `envseal init --host cursor`.');
    } else if (resolved.ids.length > 0) {
      console.log(`  Wired host(s): ${resolved.ids.join(', ')} (${resolved.source})`);
    }
    for (const entry of wiring.hosts) {
      if (entry.hint) {
        for (const line of entry.hint.split('\n')) {
          console.log(`  ${line}`);
        }
      }
    }
    if (cursorEntry === undefined && !wiring.bareTerminal) {
      console.log('  Reload MCP / restart the host, then run `envseal doctor`.');
    } else if (cursorWiring !== undefined && cursorWiring.mcp !== 'skipped' && wiring.hosts.length === 1) {
      // Cursor entry already printed reloadHint.
    } else if (wiring.bareTerminal && resolved.source === 'none') {
      // Already printed the re-run hint.
    } else if (wiring.hosts.some((h) => h.id !== 'cursor')) {
      // Per-host hints already cover reload; keep a single closer.
    }
    if (resolved.ids.includes('claude-code')) {
      console.log('  Claude Code: protocol connected (Tier B) via .mcp.json. Plugin = Tier A.');
    }
  } catch (error) {
    fail(json, error);
  }
}

