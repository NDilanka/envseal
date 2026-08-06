import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import type { ManifestEntry } from '@envseal/protocol';
import { allProbeHosts } from '@envseal/registry';
import type { ProjectPaths } from './paths.js';
import { ensureStateDir } from './paths.js';

export interface ApprovalKey {
  key: string;
  method: string;
  url: string;
  headerHash: string;
}

function canonicalHeaderString(headers: Record<string, string>): string {
  const sorted = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(sorted));
}

export function probeApprovalId(entry: ManifestEntry): string {
  if (!entry.verify) {
    return '';
  }
  const headerHash = createHash('sha256')
    .update(canonicalHeaderString(entry.verify.headerTemplate))
    .digest('hex');
  const toHash = `${entry.key}:${entry.verify.method}:${entry.verify.url}:${headerHash}`;
  return createHash('sha256').update(toHash).digest('hex');
}

function readApprovals(paths: ProjectPaths): Map<string, ApprovalKey> {
  try {
    const content = readFileSync(paths.approvals, 'utf8');
    const data = JSON.parse(content) as Record<string, ApprovalKey>;
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function writeApprovals(paths: ProjectPaths, approvals: Map<string, ApprovalKey>): void {
  const data = Object.fromEntries(approvals);
  ensureStateDir(paths);
  const content = JSON.stringify(data, null, 2);
  writeFileSync(paths.approvals, content, { mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(paths.approvals, 0o600);
  }
}

export function isHostAllowlisted(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const allowlist = allProbeHosts();
    return allowlist.has(urlObj.hostname);
  } catch {
    return false;
  }
}

export function isProbeApproved(paths: ProjectPaths, entry: ManifestEntry): boolean {
  if (!entry.verify) {
    return true;
  }
  const id = probeApprovalId(entry);
  const approvals = readApprovals(paths);
  return approvals.has(id);
}

export function recordProbeApproval(paths: ProjectPaths, entry: ManifestEntry): void {
  if (!entry.verify) {
    return;
  }
  const id = probeApprovalId(entry);
  const approvals = readApprovals(paths);
  const headerHash = createHash('sha256')
    .update(canonicalHeaderString(entry.verify.headerTemplate))
    .digest('hex');
  approvals.set(id, {
    key: entry.key,
    method: entry.verify.method,
    url: entry.verify.url,
    headerHash,
  });
  writeApprovals(paths, approvals);
}
