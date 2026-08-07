import { findProjectRoot, loadManifest, projectPaths, resolvePresence } from '@envseal/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdout } from 'node:process';

/**
 * §8.4 — Statusline ("🔑 N missing" / "🔑 ok").
 *
 * Resolves presence once, counts missing required keys, and caches the result
 * for 5 seconds so Claude Code polling does not re-run the work every tick.
 * Fail-open: any error prints "🔑 ok".
 */

export interface StatuslineInput {
  cwd?: string;
  [key: string]: unknown;
}

const CACHE_TTL_MS = 5_000;
const CACHE_FILE = join(homedir(), '.envseal', 'statusline-cache.json');

export function countMissing(root: string): number {
  const paths = projectPaths(root);
  const manifest = loadManifest(paths);
  if (manifest === null) {
    return 0;
  }
  const required = manifest.entries.filter((entry) => entry.required !== false);
  if (required.length === 0) {
    return 0;
  }
  const presence = resolvePresence(paths, required.map((entry) => entry.key));
  return required.filter((entry) => presence.get(entry.key)?.present === false).length;
}

export function render(count: number): string {
  return count > 0 ? `🔑 ${count} missing` : '🔑 ok';
}

export interface CacheEntry {
  root: string;
  lastAt: number;
  count: number;
  output: string;
}

export function readCache(): CacheEntry | null {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (
      typeof parsed.root === 'string' &&
      typeof parsed.lastAt === 'number' &&
      typeof parsed.count === 'number' &&
      typeof parsed.output === 'string'
    ) {
      return parsed as CacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCache(entry: CacheEntry): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(entry), 'utf8');
  } catch {
    // Cache is best-effort; a failure must never break the statusline.
  }
}

export function computeStatus(root: string): string {
  const cached = readCache();
  if (
    cached !== null &&
    cached.root === root &&
    Date.now() - cached.lastAt < CACHE_TTL_MS
  ) {
    return cached.output;
  }
  const count = countMissing(root);
  const output = render(count);
  writeCache({ root, lastAt: Date.now(), count, output });
  return output;
}

export function run(): void {
  const root = findProjectRoot(process.cwd());
  try {
    stdout.write(computeStatus(root) + '\n');
  } catch {
    stdout.write('🔑 ok\n');
  }
}

run();
