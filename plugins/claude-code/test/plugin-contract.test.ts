import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the two contracts Claude Code enforces and no other test in this
 * package can see: the plugin manifest schema, and the hook stdout shape.
 *
 * Both have failed silently before. The committed manifest used invented field
 * names (`mcp_servers`, `slash_commands`, `statusline_item`, a `hooks` ARRAY)
 * plus absolute paths baked in from one developer's disk, so `claude plugin
 * validate` rejected it and the plugin loaded nothing. Independently, all three
 * hooks wrote their decision to top-level keys that Claude Code never reads —
 * `pre-tool-use` returned `permissionDecision` at the root, so every `.env`
 * read it existed to deny was allowed, while the process exited 0.
 *
 * The pre-existing suite stayed green through both. Its bundle assertion was
 * `expect(JSON.stringify(parsed)).toContain('deny')`, which matches the broken
 * shape, the fixed shape, and `{"x":"deny"}` alike. Every assertion here names
 * the exact nested path Claude Code reads, so a shape regression cannot pass.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const PLUGIN_ROOT = resolve(HERE, '..');
const HOOK_DIST = join(PLUGIN_ROOT, 'hooks', 'dist');

const PLUGIN_JSON = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const HOOKS_JSON = join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const MCP_JSON = join(PLUGIN_ROOT, '.mcp.json');

/** Windows drive path (D:\x, D:/x) or a POSIX absolute path. */
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:[\\/]|(?:^|["\s,[])\/(?:[A-Za-z]))/;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value === 'object' && value !== null && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

interface HookCommand {
  type?: unknown;
  command?: unknown;
  args?: unknown;
}
interface HookMatcherGroup {
  matcher?: unknown;
  hooks?: unknown;
}

/** Every `${CLAUDE_PLUGIN_ROOT}`-relative file path referenced by a config. */
function pluginRootPaths(text: string): string[] {
  return [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}([^"]*)/g)].map((m) => m[1] ?? '');
}

describe('plugin manifest matches the Claude Code schema', () => {
  it('all three config files are present and parse', () => {
    for (const file of [PLUGIN_JSON, HOOKS_JSON, MCP_JSON]) {
      expect(existsSync(file), `${file} missing`).toBe(true);
      expect(() => readJson(file)).not.toThrow();
    }
  });

  it('declares only fields Claude Code recognises', () => {
    const manifest = asRecord(readJson(PLUGIN_JSON));

    // These four were all invented; Claude Code silently ignores the first
    // three and fails the whole plugin to load on the fourth.
    for (const invented of ['mcp_servers', 'slash_commands', 'statusline_item']) {
      expect(Object.keys(manifest), `${invented} is not a plugin.json field`).not.toContain(
        invented,
      );
    }

    expect(manifest.name).toBe('envseal');
    // `author` as a bare string is a hard validation error, not a warning.
    expect(Array.isArray(manifest.author)).toBe(false);
    expect(typeof manifest.author).toBe('object');
    expect(asRecord(manifest.author).name).toBe('envseal');
  });

  it('carries no absolute path in any config file', () => {
    for (const file of [PLUGIN_JSON, HOOKS_JSON, MCP_JSON]) {
      const text = readFileSync(file, 'utf8');
      const offending = text
        .split('\n')
        .filter((line) => ABSOLUTE_PATH_RE.test(line))
        // Metadata URLs ($schema, homepage) are not filesystem paths.
        .filter((line) => !/https?:\/\//.test(line));
      expect(
        offending,
        `${file} hardcodes a machine-specific path; use \${CLAUDE_PLUGIN_ROOT}`,
      ).toEqual([]);
    }
  });

  it('never escapes the plugin root (marketplace installs copy the plugin)', () => {
    for (const file of [HOOKS_JSON, MCP_JSON]) {
      for (const rel of pluginRootPaths(readFileSync(file, 'utf8'))) {
        expect(rel, `${file}: "${rel}" traverses outside the plugin root`).not.toContain('..');
      }
    }
  });
});

describe('hooks.json wires the three documented events', () => {
  const hooksFile = asRecord(readJson(HOOKS_JSON));
  const events = asRecord(hooksFile.hooks);

  it('is an object keyed by PascalCase event names, not an array', () => {
    expect(Array.isArray(hooksFile.hooks)).toBe(false);
    expect(Object.keys(events).sort()).toEqual(['PreToolUse', 'SessionStart', 'UserPromptSubmit']);
  });

  it.each(['PreToolUse', 'UserPromptSubmit', 'SessionStart'])(
    '%s runs an existing bundle through ${CLAUDE_PLUGIN_ROOT}',
    (event) => {
      const groups = events[event] as HookMatcherGroup[];
      expect(Array.isArray(groups)).toBe(true);
      expect(groups.length).toBeGreaterThan(0);

      const commands = groups.flatMap((g) => g.hooks as HookCommand[]);
      expect(commands.length).toBeGreaterThan(0);

      for (const cmd of commands) {
        expect(cmd.type).toBe('command');
        // Exec form: args present means no shell tokenisation, so a plugin
        // root containing spaces (C:\Users\A S U S\...) survives intact.
        expect(Array.isArray(cmd.args)).toBe(true);
        const args = cmd.args as string[];
        const target = args[0];
        expect(typeof target).toBe('string');
        expect(target).toContain('${CLAUDE_PLUGIN_ROOT}');

        const onDisk = join(PLUGIN_ROOT, (target as string).replace('${CLAUDE_PLUGIN_ROOT}', ''));
        expect(existsSync(onDisk), `${event} points at missing bundle ${onDisk}`).toBe(true);
      }
    },
  );

  it('the PreToolUse matcher covers every tool the hook decides on', async () => {
    const groups = events.PreToolUse as HookMatcherGroup[];
    const matcher = String(groups[0]?.matcher ?? '');
    // Imported from source purely to read the tool list the logic branches on;
    // the behavioural assertions below all run the built bundle.
    const { FILE_TOOLS_FOR_TEST } = await import('../hooks/pre-tool-use.js');
    for (const tool of [...FILE_TOOLS_FOR_TEST, 'Bash']) {
      expect(
        matcher.split('|'),
        `hooks.json PreToolUse matcher omits ${tool}, so the guard never sees it`,
      ).toContain(tool);
    }
  });
});

describe('.mcp.json reaches a bundled server', () => {
  const mcp = asRecord(readJson(MCP_JSON));

  it('uses the camelCase mcpServers object, not an mcp_servers array', () => {
    expect(Object.keys(mcp)).toEqual(['mcpServers']);
    expect(Array.isArray(mcp.mcpServers)).toBe(false);
  });

  it('points at a server bundled inside the plugin', () => {
    const servers = asRecord(mcp.mcpServers);
    expect(Object.keys(servers).length).toBeGreaterThan(0);

    for (const [name, raw] of Object.entries(servers)) {
      const server = asRecord(raw);
      const args = server.args as string[];
      expect(Array.isArray(args), `${name} has no args`).toBe(true);
      const entry = args[0];
      expect(typeof entry).toBe('string');
      expect(entry).toContain('${CLAUDE_PLUGIN_ROOT}');

      const onDisk = join(PLUGIN_ROOT, (entry as string).replace('${CLAUDE_PLUGIN_ROOT}', ''));
      expect(
        existsSync(onDisk),
        `${name} points at ${onDisk}, which the build did not produce`,
      ).toBe(true);
    }
  });
});

describe('the seven slash commands are discoverable', () => {
  const EXPECTED = [
    'env-allow-once',
    'env-doctor',
    'env-rotate',
    'env-set',
    'env-setup',
    'env-status',
    'env-verify',
  ];

  it('lives in the default commands/ directory Claude Code scans', () => {
    const dir = join(PLUGIN_ROOT, 'commands');
    const found = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(found).toEqual(EXPECTED);
  });

  it.each(EXPECTED)('%s.md opens with a description frontmatter block', (name) => {
    const text = readFileSync(join(PLUGIN_ROOT, 'commands', `${name}.md`), 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    const frontmatter = text.split('\n---', 2)[0] ?? '';
    expect(frontmatter).toMatch(/^description:.+$/m);
  });
});

/**
 * These run the BUILT bundles and assert on the exact nested key Claude Code
 * reads. Asserting that the word "deny" appears somewhere in stdout — what the
 * previous suite did — passes on a hook whose decision is ignored.
 */
describe('bundled hooks emit the shapes Claude Code reads', () => {
  function runHook(bundle: string, payload: unknown): { parsed: unknown; out: string; code: number } {
    const res = spawnSync(process.execPath, [join(HOOK_DIST, bundle)], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(res.stderr ?? '').not.toContain('MODULE_NOT_FOUND');
    expect(res.status, `${bundle} exited ${res.status}: ${res.stderr}`).toBe(0);
    const out = res.stdout ?? '';
    return { parsed: JSON.parse(out) as unknown, out, code: res.status ?? -1 };
  }

  const DOTENV = '.env';

  it('PreToolUse denies a dotenv read at hookSpecificOutput.permissionDecision', () => {
    const { parsed } = runHook('pre-tool-use.cjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: DOTENV },
    });
    const hso = asRecord(asRecord(parsed).hookSpecificOutput);
    expect(hso.hookEventName).toBe('PreToolUse');
    expect(hso.permissionDecision).toBe('deny');
    expect(String(hso.permissionDecisionReason)).toMatch(/env_describe|env_verify/);
  });

  it.each(['Read', 'Edit', 'Write', 'MultiEdit'])(
    'PreToolUse denies %s against a dotenv file',
    (tool) => {
      const { parsed } = runHook('pre-tool-use.cjs', {
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: { file_path: DOTENV },
      });
      expect(asRecord(asRecord(parsed).hookSpecificOutput).permissionDecision).toBe('deny');
    },
  );

  it('PreToolUse allows an ordinary source read', () => {
    const { parsed } = runHook('pre-tool-use.cjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts' },
    });
    expect(asRecord(asRecord(parsed).hookSpecificOutput).permissionDecision).toBe('allow');
  });

  it('PreToolUse denies a shell read of a dotenv file', () => {
    const { parsed } = runHook('pre-tool-use.cjs', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `cat ${DOTENV}` },
    });
    expect(asRecord(asRecord(parsed).hookSpecificOutput).permissionDecision).toBe('deny');
  });

  it('SessionStart puts its note at hookSpecificOutput.additionalContext', () => {
    const { parsed } = runHook('session-start.cjs', {
      hook_event_name: 'SessionStart',
      cwd: PLUGIN_ROOT,
      source: 'startup',
    });
    const hso = asRecord(asRecord(parsed).hookSpecificOutput);
    expect(hso.hookEventName).toBe('SessionStart');
    expect(typeof hso.additionalContext).toBe('string');
    // The old shape nested hookSpecificOutput inside itself.
    expect(hso.hookSpecificOutput).toBeUndefined();
  });

  it('UserPromptSubmit blocks a pasted key rather than claiming to rewrite it', () => {
    const secret = `sk-${'A1b2C3d4E5f6G7h8'.repeat(3)}`;
    const { parsed, out } = runHook('user-prompt-submit.cjs', {
      hook_event_name: 'UserPromptSubmit',
      prompt: `here is my key ${secret} please use it`,
    });
    // UserPromptSubmit has no documented prompt-rewrite field: blocking is the
    // only output that actually keeps the value away from the model.
    expect(asRecord(parsed).decision).toBe('block');
    expect(out).not.toContain(secret);
    expect(out).not.toMatch(/modifiedPrompt|modifiedMessage/);
  });

  it('UserPromptSubmit lets ordinary prose through without echoing it back', () => {
    const prose = 'Please refactor the auth middleware and add a retry test.';
    const { parsed, out } = runHook('user-prompt-submit.cjs', {
      hook_event_name: 'UserPromptSubmit',
      prompt: prose,
    });
    expect(asRecord(parsed).decision).toBeUndefined();
    // stdout is injected as context for this event, so echoing the prompt back
    // would duplicate it into the conversation.
    expect(out).not.toContain(prose);
  });
});
