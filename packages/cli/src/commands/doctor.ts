import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SepError } from '@envseal/protocol';
import { inspectDotenvGitSafety, loadManifest, projectPaths, readHookHeartbeat } from '@envseal/core';
import { emit, fail } from '../output.js';
import { EXIT } from '../exit-codes.js';
import { detectHost } from '../host.js';
import { createBroker } from '../cli-utils.js';
import { finish } from '../exit.js';
import { inspectPrimaryHostWiring, wiringFailsDoctor } from '../host-wiring/inspect.js';

export async function doctor(root: string, json: boolean): Promise<void> {
  try {
    // An audit of a project with no configuration would report an empty,
    // healthy-looking bill of health: gitignore/no, missing keys/0, exit 0.
    // Every other command treats that state as SEP_NOT_DECLARED; the audit
    // command must not be the one place it reads as success.
    const manifestPath = join(root, 'env.schema.jsonc');
    if (!existsSync(manifestPath)) {
      fail(
        json,
        new SepError({
          code: 'SEP_NOT_DECLARED',
          userMessage:
            'No env.schema.jsonc in this project (or parents). Run `envseal init` to create one.',
        }),
      );
      return;
    }

    const manifest = loadManifest(projectPaths(root));

    const broker = await createBroker(root);
    const status = await broker.describe();

    const gitignorePath = join(root, '.gitignore');
    const envPath = join(root, '.env');
    const gitSafety = inspectDotenvGitSafety(projectPaths(root));
    const gitignoreCovers = gitSafety.ignored;
    const hookFailClosed = process.env.ENVSEAL_HOOK_FAIL_CLOSED === '1';

    // Check .env permissions
    let envFileOk = false;
    if (existsSync(envPath)) {
      const stats = statSync(envPath);
      envFileOk = (stats.mode & 0o077) === 0;
    }

    const host = detectHost(root);
    const egress = manifest?.policy?.egress;
    const inspection = inspectPrimaryHostWiring(root, host.id, { probe: true });
    const hookLastRan = readHookHeartbeat(root);
    const output = {
      projectRoot: root,
      manifestPath,
      host: {
        id: host.id,
        name: host.name,
        tier: host.tier,
        reason: host.reason,
        recommendation: host.recommendation,
      },
      agentWiring: inspection.wiring,
      gitignore: {
        exists: existsSync(gitignorePath),
        covers: gitignoreCovers,
      },
      envFile: {
        exists: existsSync(envPath),
        isTracked: gitSafety.tracked,
        permissionsOk: envFileOk,
      },
      egressPolicy: egress ?? { mode: 'warn', allow: [] },
      hookFailClosed,
      hookLastRan,
      missingRequiredCount: status.missingRequired.length,
      missingRequired: status.missingRequired,
      ...(inspection.mcp === undefined
        ? {}
        : {
            mcp: {
              wired: inspection.mcp.wired,
              status: inspection.mcp.status,
              message: inspection.mcp.message,
              commandOk: inspection.mcp.commandOk,
            },
          }),
    };

    if (!json) {
      console.log(`Project root: ${root}`);
      console.log(`Host: ${host.name} (Tier ${host.tier})`);
      console.log(`  ${host.reason}`);
      console.log(`  ${host.recommendation}`);
      console.log(
        `Agent wiring: MCP ${inspection.wiring.mcp}, instructions ${inspection.wiring.instructions}`,
      );
      if (inspection.notOotb) {
        console.log('  This host is not OOTB (print-only MCP). Layer 1 AGENTS.md is the working path.');
      }
      console.log(`  ${inspection.message}`);
      console.log(`Gitignore covers .env: ${gitignoreCovers ? 'yes' : 'no'}`);
      console.log(
        `Egress policy: ${egress?.mode === 'allowlist' ? `allowlist (${egress.allow.length} allowed host${egress.allow.length === 1 ? '' : 's'})` : 'warn (default)'}`,
      );
      console.log(
        `Hook on internal error: ${hookFailClosed ? 'fail-closed' : 'fail-open (default)'}`,
      );
      console.log(`Hook heartbeat: ${describeHeartbeatAge(hookLastRan)}`);
      console.log(`Missing required keys: ${status.missingRequired.length}`);
      if (status.missingRequired.length > 0) {
        for (const key of status.missingRequired) {
          console.log(`  - ${key}`);
        }
      }
    } else {
      emit(json, '', output);
    }

    if (status.missingRequired.length > 0 || wiringFailsDoctor(inspection)) {
      finish(EXIT.UNSATISFIED);
      return;
    }
  } catch (error) {
    fail(json, error);
  }
}

/**
 * Human phrasing for the hook heartbeat. Advisory only — wiring can be
 * present while the hook has never run (no plugin version, no tool call yet),
 * and a recent timestamp proves liveness, not correctness.
 */
function describeHeartbeatAge(hookLastRan: string | null): string {
  if (hookLastRan === null) {
    return 'none recorded (hook has not run for this project, or pre-heartbeat plugin)';
  }
  const then = Date.parse(hookLastRan);
  if (Number.isNaN(then)) {
    return 'unreadable timestamp';
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
