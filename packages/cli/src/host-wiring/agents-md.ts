import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_MD_CONTENT } from './agents-md-content.js';

export type AgentsMdAction = 'created' | 'merged' | 'unchanged';

/**
 * The envseal imperative: never read .env, use ensure/run instead of a paste.
 * Doctor and init both use this so "instructions exist" is not just a filename.
 */
export function hasEnvsealImperative(text: string): boolean {
  const neverEnv = /never/i.test(text) && /\.env/i.test(text);
  const useEnsure = /envseal\s+ensure/i.test(text);
  const useRun = /envseal\s+run/i.test(text);
  return neverEnv && useEnsure && useRun;
}

export function inspectAgentsMd(root: string): {
  path: string;
  exists: boolean;
  instructions: 'ok' | 'missing';
} {
  const path = join(root, 'AGENTS.md');
  if (!existsSync(path)) {
    return { path, exists: false, instructions: 'missing' };
  }
  try {
    const text = readFileSync(path, 'utf8');
    return {
      path,
      exists: true,
      instructions: hasEnvsealImperative(text) ? 'ok' : 'missing',
    };
  } catch {
    return { path, exists: true, instructions: 'missing' };
  }
}

/**
 * Merge plugins/generic/AGENTS.md into project-root AGENTS.md.
 * Creates the file, or appends an envseal section; never clobbers unrelated content.
 */
export function mergeAgentsMd(root: string): { action: AgentsMdAction; path: string } {
  const path = join(root, 'AGENTS.md');
  if (!existsSync(path)) {
    writeFileSync(path, AGENTS_MD_CONTENT, 'utf8');
    return { action: 'created', path };
  }

  const existing = readFileSync(path, 'utf8');
  if (hasEnvsealImperative(existing)) {
    return { action: 'unchanged', path };
  }

  const trimmed = existing.replace(/\s+$/u, '');
  const next = `${trimmed}\n\n${AGENTS_MD_CONTENT}`;
  writeFileSync(path, next, 'utf8');
  return { action: 'merged', path };
}
