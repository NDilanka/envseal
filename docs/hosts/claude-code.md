# Claude Code integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **A** — protocol + interception hooks |
| **Config file** | `.claude-plugin/plugin.json` (bundled plugin) or `.mcp.json` |

Claude Code is the only host with **Tier A**: the bundled plugin (`plugins/claude-code`)
adds a `PreToolUse` guard that denies reads of `.env`/secret paths and env-dumping
shell commands, a `UserPromptSubmit` redactor that intercepts pasted keys, a
`SessionStart` note and statusline. Prefer the plugin.

## Install (Tier A plugin)

```sh
envseal init --host claude-code
```

or install the plugin from this repo (`plugins/claude-code`, `.claude-plugin/plugin.json`).
`envseal doctor` should report `Host: Claude Code (Tier A)`.

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