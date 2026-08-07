import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the BUNDLED hooks — the artifacts Claude Code actually executes.
 *
 * The other suites in this package import the hook source directly, which
 * verifies the decision logic but says nothing about whether the bundle loads.
 * That gap is not hypothetical: all three bundles once shipped crashing at
 * startup with MODULE_NOT_FOUND (esbuild resolved jsonc-parser's UMD entry,
 * whose internal require('./impl/*') calls do not survive bundling) while 107
 * source-level tests passed. A hook that cannot start is a hook that silently
 * grants every request it was installed to deny.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const HOOKS = resolve(HERE, '..', 'hooks', 'dist');

function runHook(name: string, payload: unknown): { stdout: string; stderr: string; code: number } {
  const file = join(HOOKS, name);
  const res = spawnSync(process.execPath, [file], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? -1 };
}

describe('bundled hooks execute', () => {
  it('all three bundles and the statusline exist', () => {
    for (const f of ['pre-tool-use.cjs', 'user-prompt-submit.cjs', 'session-start.cjs']) {
      expect(existsSync(join(HOOKS, f)), `${f} missing`).toBe(true);
    }
    expect(
      existsSync(resolve(HERE, '..', 'statusline', 'dist', 'statusline.cjs')),
    ).toBe(true);
  });

  it('pre-tool-use loads and denies reading a dotenv file', () => {
    const r = runHook('pre-tool-use.cjs', {
      tool_name: 'Read',
      tool_input: { file_path: '.env' },
    });
    expect(r.stderr).not.toContain('MODULE_NOT_FOUND');
    expect(r.code).toBe(0);
    const out = JSON.stringify(JSON.parse(r.stdout || '{}'));
    expect(out.toLowerCase()).toContain('deny');
    // Instructive, not bare: a model told what to do instead complies; one that
    // is merely blocked goes looking for a workaround.
    expect(out).toMatch(/env_describe|env_verify/);
  });

  it('pre-tool-use loads and allows an ordinary source read', () => {
    const r = runHook('pre-tool-use.cjs', {
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts' },
    });
    expect(r.stderr).not.toContain('MODULE_NOT_FOUND');
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).not.toContain('"deny"');
  });

  it('user-prompt-submit loads and redacts a pasted key without echoing it', () => {
    const fake = 'sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const r = runHook('user-prompt-submit.cjs', {
      prompt: `here is my key ${fake} please add it`,
    });
    expect(r.stderr).not.toContain('MODULE_NOT_FOUND');
    expect(r.code).toBe(0);
    // The hook's own output must never carry the value it just caught.
    expect(r.stdout).not.toContain(fake);
    expect(r.stderr).not.toContain(fake);
  });

  it('user-prompt-submit passes ordinary prose through untouched', () => {
    const prose = 'Please refactor the auth middleware and add a test for the retry path.';
    const r = runHook('user-prompt-submit.cjs', { prompt: prose });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('redacted');
  });

  it('session-start loads without crashing', () => {
    const r = runHook('session-start.cjs', { cwd: process.cwd() });
    expect(r.stderr).not.toContain('MODULE_NOT_FOUND');
    expect(r.code).toBe(0);
  });
});
