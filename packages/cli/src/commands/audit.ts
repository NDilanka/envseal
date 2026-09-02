import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareWithMirror, projectPaths, readAudit, readMirrorLines, verifyAuditChain } from '@envseal/core';
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
 *
 * When the project's out-of-band mirror (~/.envseal/mirrors/) exists, verify
 * also compares the log against it: the mirror is a second copy the project's
 * agent cannot silently shrink, so records the mirror proves existed but the
 * log lost are tail truncation — exit 7. See docs/residual-risks.md §10.
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
  const mirror = compareWithMirror(raw, readMirrorLines(root));
  const ok = result.ok && !mirror.tailTruncated;

  if (json) {
    console.log(
      JSON.stringify(
        !ok
          ? {
              ok: false,
              brokenAt: result.ok ? null : (result.brokenAt ?? null),
              count: result.count,
              mirror: { present: mirror.mirrorPresent, records: mirror.mirrorRecords },
            }
          : { ok: true, count: result.count, mirror: { present: mirror.mirrorPresent, records: mirror.mirrorRecords } },
        null,
        0,
      ),
    );
    finish(ok ? EXIT.OK : EXIT.AUDIT_CHAIN_FAILED);
    return;
  }

  if (!ok) {
    if (!result.ok) {
      console.error(
        `AUDIT CHAIN FAILED: first break at record ${result.brokenAt} of ${result.count}. ` +
          'Records were edited, deleted, reordered, or spliced after the fact. ' +
          'Treat every record after the break as untrusted and investigate the host.',
      );
    } else {
      console.error(
        `AUDIT TAIL LOST: the project log holds ${mirror.projectRecords} record(s) but its out-of-band mirror ` +
          `attests ${mirror.mirrorRecords}. Records after the surviving tail were deleted after being mirrored. ` +
          'Treat the log as incomplete and investigate the host (docs/residual-risks.md §10).',
      );
    }
    finish(EXIT.AUDIT_CHAIN_FAILED);
    return;
  }
  if (mirror.mirrorPresent && mirror.mirrorRecords > mirror.projectRecords) {
    console.log(
      `Audit chain intact (${result.count} record${result.count === 1 ? '' : 's'}); mirror holds ` +
        `${mirror.mirrorRecords} — pre-reset history, not tampering.`,
    );
  } else {
    console.log(`Audit chain intact (${result.count} record${result.count === 1 ? '' : 's'}).`);
  }
  finish(EXIT.OK);
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
