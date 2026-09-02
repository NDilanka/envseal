#!/usr/bin/env node
// Arms the gauntlet as a pre-push git hook: every `git push` runs
// `pnpm gauntlet` (agent-validate: build, typecheck, lint, test) and the push
// aborts when a gate fails. Local-only by design — .githooks/ is gitignored.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const hooksDir = join(root, '.githooks');
mkdirSync(hooksDir, { recursive: true });

const hook = `#!/bin/sh
# Installed by scripts/install-gauntlet-hook.mjs — the gauntlet loop gates every push.
pnpm gauntlet || {
  echo "gauntlet: gates failed — push aborted. Fix, re-run 'pnpm gauntlet', then 'pnpm gauntlet:skip' to advance the baseline." >&2
  exit 1
}
`;
writeFileSync(join(hooksDir, 'pre-push'), hook, { mode: 0o755 });

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe' });
console.log('gauntlet armed: core.hooksPath=.githooks, pre-push runs `pnpm gauntlet`');
