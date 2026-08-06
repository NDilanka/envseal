import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ProjectPaths {
  root: string;
  manifest: string;
  dotenv: string;
  stateDir: string;
  salt: string;
  approvals: string;
  audit: string;
}

export function projectPaths(root: string): ProjectPaths {
  const normalizedRoot = resolve(root);
  return {
    root: normalizedRoot,
    manifest: join(normalizedRoot, 'env.schema.jsonc'),
    dotenv: join(normalizedRoot, '.env'),
    stateDir: join(normalizedRoot, '.envseal'),
    salt: join(normalizedRoot, '.envseal', 'salt'),
    approvals: join(normalizedRoot, '.envseal', 'approvals.json'),
    audit: join(normalizedRoot, '.envseal', 'audit.jsonl'),
  };
}

export function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  const original = dir;
  for (;;) {
    if (existsSync(join(dir, 'env.schema.jsonc'))) return dir;
    if (existsSync(join(dir, '.git'))) return dir;
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return original;
    dir = parent;
  }
}

const isPosix = process.platform !== 'win32';

export function ensureStateDir(paths: ProjectPaths): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  if (isPosix) chmodSync(paths.stateDir, 0o700);
}

export function loadOrCreateSalt(paths: ProjectPaths): Buffer {
  ensureStateDir(paths);
  try {
    const existing = readFileSync(paths.salt);
    if (existing.length === 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const salt = randomBytes(32);
  writeFileSync(paths.salt, salt, { mode: 0o600 });
  if (isPosix) chmodSync(paths.salt, 0o600);
  return salt;
}
