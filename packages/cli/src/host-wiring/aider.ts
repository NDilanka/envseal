import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AIDER_CONF_YML } from './aider-conf.js';
import type { McpWriteAction } from './mcp.js';

const AIDER_FILENAMES = [
  '.aider.conf.yml',
  '.aider.conf.yaml',
  'aider.conf.yml',
  'aider.conf.yaml',
  '.aider.conf.json',
  'aider.conf.json',
];

/** A `read:` list item that would dump `.env` into Aider's chat context. */
const ENV_READ_ITEM = /^\s*-\s+['"]?\.env(?:\..*?)?['"]?\s*$/;

export function aiderConfPath(root: string): string | undefined {
  for (const name of AIDER_FILENAMES) {
    const path = join(root, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function aiderReadListIncludesEnv(text: string): boolean {
  return text.split(/\r?\n/).some((line) => ENV_READ_ITEM.test(line) && !/example/i.test(line));
}

function stripEnvFromReadList(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !(ENV_READ_ITEM.test(line) && !/example/i.test(line)))
    .join('\n');
}

function ensureSafeReadEntries(text: string): string {
  let next = stripEnvFromReadList(text);
  if (!/^read:/m.test(next)) {
    const trimmed = next.replace(/\s+$/u, '');
    return `${trimmed}\n\nread:\n  - env.schema.jsonc\n  - .env.example\n`;
  }
  if (!/env\.schema\.jsonc/.test(next)) {
    next = next.replace(/^read:\s*$/m, 'read:\n  - env.schema.jsonc');
    if (!/env\.schema\.jsonc/.test(next)) {
      next = next.replace(/^read:/m, 'read:\n  - env.schema.jsonc');
    }
  }
  if (!/\.env\.example/.test(next)) {
    next = next.replace(/(env\.schema\.jsonc[^\n]*)/, '$1\n  - .env.example');
  }
  return next;
}

export function inspectAiderConf(root: string): {
  path: string | undefined;
  envOnRead: boolean;
  wired: boolean;
  message: string;
} {
  const path = aiderConfPath(root);
  if (path === undefined) {
    return {
      path,
      envOnRead: false,
      wired: false,
      message: 'No Aider config found. Run `envseal init --host aider` to write .aider.conf.yml.',
    };
  }
  const text = readFileSync(path, 'utf8');
  const envOnRead = aiderReadListIncludesEnv(text);
  if (envOnRead) {
    return {
      path,
      envOnRead: true,
      wired: false,
      message: `${path} lists .env under read: — Aider would paste secrets into chat. Re-run envseal init --host aider.`,
    };
  }
  return {
    path,
    envOnRead: false,
    wired: true,
    message: 'Aider config does not put .env on the read list.',
  };
}

export function mergeAiderConf(root: string): { action: McpWriteAction; path: string } {
  const existing = aiderConfPath(root);
  const path = existing ?? join(root, '.aider.conf.yml');

  if (!existsSync(path)) {
    writeFileSync(path, AIDER_CONF_YML, 'utf8');
    return { action: 'created', path };
  }

  const text = readFileSync(path, 'utf8');
  const next = ensureSafeReadEntries(text);
  if (next === text) {
    return { action: 'unchanged', path };
  }
  writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  return { action: 'merged', path };
}
