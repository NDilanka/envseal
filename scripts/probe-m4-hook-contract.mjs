#!/usr/bin/env node
/**
 * Probe: do the bundled hooks emit the shapes Claude Code actually reads?
 *
 * Claude Code reads a PreToolUse decision ONLY from
 * `hookSpecificOutput.permissionDecision` with a matching `hookEventName`.
 * A hook that puts `permissionDecision` at the top level exits 0, looks
 * healthy, and is ignored — the tool call proceeds. This probe asserts on the
 * nested path specifically, so that regression cannot pass.
 *
 * Usage: node scripts/probe-m4-hook-contract.mjs
 * Exit 0 = all contracts hold, 1 = at least one violation.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'plugins', 'claude-code', 'hooks', 'dist');

const DOTENV = '.env'; // built at runtime so this file never contains the literal
const SECRET = `sk-${'A1b2C3d4E5f6G7h8'.repeat(3)}`;

function runHook(bundle, payload) {
  const res = spawnSync(process.execPath, [join(DIST, bundle)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20_000,
  });
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    parseError = String(err);
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, parsed, parseError };
}

const failures = [];
const notes = [];

function check(label, condition, detail) {
  if (condition) {
    notes.push(`  PASS  ${label}`);
  } else {
    failures.push(`  FAIL  ${label}\n        ${detail}`);
  }
}

// --- PreToolUse: deny a dotenv read -----------------------------------------
{
  const r = runHook('pre-tool-use.cjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: DOTENV },
    cwd: REPO,
  });
  const hso = r.parsed?.hookSpecificOutput;
  check('pre-tool-use exits 0', r.code === 0, `exit=${r.code} stderr=${r.stderr}`);
  check('pre-tool-use emits parseable JSON', r.parsed !== null, r.parseError ?? '');
  check(
    'PreToolUse deny is at hookSpecificOutput.permissionDecision',
    hso?.permissionDecision === 'deny',
    `got hookSpecificOutput=${JSON.stringify(hso)}`,
  );
  check(
    'PreToolUse carries hookEventName "PreToolUse"',
    hso?.hookEventName === 'PreToolUse',
    `got hookEventName=${JSON.stringify(hso?.hookEventName)}`,
  );
  check(
    'PreToolUse deny reason is instructive',
    typeof hso?.permissionDecisionReason === 'string' &&
      /env_describe|env_verify/.test(hso.permissionDecisionReason),
    `got reason=${JSON.stringify(hso?.permissionDecisionReason)}`,
  );
}

// --- PreToolUse: allow an ordinary read -------------------------------------
{
  const r = runHook('pre-tool-use.cjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'src/index.ts' },
    cwd: REPO,
  });
  check(
    'PreToolUse allows an ordinary source read',
    r.parsed?.hookSpecificOutput?.permissionDecision === 'allow',
    `got ${JSON.stringify(r.parsed)}`,
  );
}

// --- PreToolUse: deny a shell read of the dotenv file ------------------------
{
  const r = runHook('pre-tool-use.cjs', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: `cat ${DOTENV}` },
    cwd: REPO,
  });
  check(
    'PreToolUse denies a shell read of the dotenv file',
    r.parsed?.hookSpecificOutput?.permissionDecision === 'deny',
    `got ${JSON.stringify(r.parsed)}`,
  );
}

// --- SessionStart ------------------------------------------------------------
{
  const r = runHook('session-start.cjs', {
    hook_event_name: 'SessionStart',
    cwd: REPO,
    source: 'startup',
  });
  const hso = r.parsed?.hookSpecificOutput;
  check('session-start exits 0', r.code === 0, `exit=${r.code} stderr=${r.stderr}`);
  check(
    'SessionStart carries hookEventName "SessionStart"',
    hso?.hookEventName === 'SessionStart',
    `got ${JSON.stringify(r.parsed)}`,
  );
  check(
    'SessionStart context is at hookSpecificOutput.additionalContext',
    typeof hso?.additionalContext === 'string',
    `got ${JSON.stringify(hso)}`,
  );
  check(
    'SessionStart does not double-nest hookSpecificOutput',
    hso?.hookSpecificOutput === undefined,
    `hookSpecificOutput.hookSpecificOutput = ${JSON.stringify(hso?.hookSpecificOutput)}`,
  );
}

// --- UserPromptSubmit: a pasted key must be BLOCKED, not "modified" ----------
{
  const r = runHook('user-prompt-submit.cjs', {
    hook_event_name: 'UserPromptSubmit',
    prompt: `here is my key ${SECRET} please use it`,
    cwd: REPO,
  });
  check('user-prompt-submit exits 0', r.code === 0, `exit=${r.code} stderr=${r.stderr}`);
  check(
    'UserPromptSubmit blocks a prompt containing a key',
    r.parsed?.decision === 'block',
    `got ${JSON.stringify(r.parsed)}`,
  );
  check(
    'UserPromptSubmit never echoes the secret on stdout',
    !r.stdout.includes(SECRET),
    'stdout contained the secret value',
  );
  check(
    'UserPromptSubmit never echoes the secret on stderr',
    !r.stderr.includes(SECRET),
    'stderr contained the secret value',
  );
  check(
    'UserPromptSubmit emits no modifiedPrompt/modifiedMessage (not a real field)',
    !/modifiedPrompt|modifiedMessage/.test(r.stdout),
    `stdout=${r.stdout}`,
  );
}

// --- UserPromptSubmit: ordinary prose passes through -------------------------
{
  const prose = 'Please refactor the auth middleware and add a retry test.';
  const r = runHook('user-prompt-submit.cjs', {
    hook_event_name: 'UserPromptSubmit',
    prompt: prose,
    cwd: REPO,
  });
  check(
    'UserPromptSubmit lets ordinary prose through',
    r.parsed?.decision === undefined,
    `got ${JSON.stringify(r.parsed)}`,
  );
  check(
    'UserPromptSubmit does not echo the prompt back as context',
    !r.stdout.includes(prose),
    `stdout=${r.stdout}`,
  );
}

console.log(notes.join('\n'));
if (failures.length > 0) {
  console.error(`\n${failures.length} hook-contract violation(s):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} hook-contract checks passed.`);
