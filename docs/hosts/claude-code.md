# Claude Code integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **A** — protocol + interception hooks |
| **Config file** | `.claude-plugin/plugin.json` (the plugin in this repo, `plugins/claude-code`) or `.mcp.json` |

Claude Code is the only host with **Tier A**: the plugin in this repo
(`plugins/claude-code`) adds a `PreToolUse` guard that denies reads of
`.env`/secret paths and env-dumping shell commands, a `UserPromptSubmit`
redactor that intercepts pasted keys, a `SessionStart` note and statusline.
Prefer the plugin.

## Install (Tier A plugin)

```sh
envseal init --host claude-code
```

Note that `init` prints `(protection tier C)` for any `--host` override — it
cannot verify wiring from a flag alone — so trust `envseal doctor`'s
evidence-based report instead.

or install the plugin from this repo (`plugins/claude-code`, `.claude-plugin/plugin.json`).
`envseal doctor` reports `Host: Claude Code (Tier A)` only when it can see the
hooks actually installed: an envseal + hooks entry in the project or home
`.claude/settings.json` (or `settings.local.json`), or the plugin copied under
`.claude/plugins/envseal/`. With only `.claude-plugin/plugin.json` present,
doctor reports `Claude Code (Tier B)`. Inside a Claude Code session
(`CLAUDECODE` set), Claude Code is detected either way, but Tier A still
requires the visible hook wiring.

## Config snippet (bare MCP, no hooks)

If you only want the protocol without the plugin, project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "envseal-mcp": {
      "command": "envseal-mcp",
      "args": []
    }
  }
}
```

Claude Code reads MCP config from `.mcp.json` at the project root (documented by
Anthropic); without the plugin you are Tier B, not A.

## Notes

- Hooks deny with instructive messages — `env_describe` for status, `env_verify`
  to test a key — so the model is told what to do instead of what not to do.
- Tier A still does not defend against `env_use` exfiltration or a user who
  clicks through a confirmation dialog (see `docs/residual-risks.md`).
- The `keychain` sink remains available and recommended for long-lived, high-value
  keys even on Tier A.