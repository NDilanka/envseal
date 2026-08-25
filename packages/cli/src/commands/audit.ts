import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths, readAudit, verifyAuditChain } from '@envseal/core';
import type { AuditEvent } from '@envseal/core';
import { EXIT } from '../exit-codes.js';
import { finish } from '../exit.js';

/**
 * `envseal audit` — inspect the project's audit log.
 *
 * Default: print recorded events (human-readable) or the raw event array
 * (--json). With --verify: check the hash chain instead; exit 7
 * (AUDIT_CHAIN_FAILED) when the chain is broken. A missing log verifies as
 * intact with zero records — there is nothing to attest, and "no log yet"
 * must not look like tampering.
 */
export async function audit(root: string, json: boolean, verifyMode: boolean): Promise<void> {
  if (!verifyMode) {
    // No manifest gate here on purpose: the log is written by provisioning and
    // use flows, and it stays readable even in a half-torn-down project whose
    // env.schema.jsonc is already gone. An audit surface that refuses to
    // audit would be its own finding.
    const events = readAudit(projectPaths(root));

    if (json) {
      console.log(JSON.stringify(events, null, 0));
      finish(EXIT.OK);
      return;
    }

    if (events.length === 0) {
      console.log('No audit events recorded.');
      finish(EXIT.OK);
      return;
    }

    for (const e of events) {
      console.log(formatEvent(e));
    }
    finish(EXIT.OK);
    return;
  }

  // --verify mode: chain check over the raw bytes. A missing file is an empty
  // chain, not an error (see doc comment).
  let raw = '';
  try {
    raw = readFileSync(join(root, '.envseal', 'audit.jsonl'), 'utf8');
  } catch {
    raw = '';
  }

  const result = verifyAuditChain(raw);

  if (json) {
    console.log(
      JSON.stringify(
        result.ok
          ? { ok: true, count: result.count }
          : { ok: false, brokenAt: result.brokenAt ?? null, count: result.count },
        null,
        0,
      ),
    );
    finish(result.ok ? EXIT.OK : EXIT.AUDIT_CHAIN_FAILED);
    return;
  }

  if (result.ok) {
    console.log(`Audit chain intact (${result.count} record${result.count === 1 ? '' : 's'}).`);
    finish(EXIT.OK);
    return;
  }
  console.error(
    `AUDIT CHAIN FAILED: first break at record ${result.brokenAt} of ${result.count}. ` +
      'Records were edited, deleted, reordered, or spliced after the fact. ' +
      'Treat every record after the break as untrusted and investigate the host.',
  );
  finish(EXIT.AUDIT_CHAIN_FAILED);
}

function formatEvent(e: AuditEvent & { at: string }): string {
  const at = e.at;
  switch (e.type) {
    case 'declare':
      return `${at} declare keys=${JSON.stringify(e.keys)}`;
    case 'request':
      return `${at} request ticket=${e.ticket} keys=${JSON.stringify(e.keys)} surface=${e.surface}`;
    case 'stored':
      return `${at} stored key=${e.key} sink=${e.sink}`;
    case 'skipped':
    case 'cancelled':
    case 'timeout':
      return `${at} ${e.type} ticket=${e.ticket} key=${e.key}`;
    case 'verify':
      return `${at} verify key=${e.key} result=${e.result}`;
    case 'revoke':
      return `${at} revoke key=${e.key} sink=${e.sink}`;
    case 'blocked':
      return `${at} blocked reason=${e.reason}`;
    case 'use':
      return `${at} use keys=${JSON.stringify(e.keys)} networkEgress=${String(e.networkEgress)} cmd=${e.command}`;
    case 'use_result':
      return `${at} use_result exit=${String(e.exitCode)} signal=${String(e.signal)} ${e.durationMs}ms`;
    default:
      return `${at} ${(e as { type: string }).type}`;
  }
}
