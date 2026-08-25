# Claude Code integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** from `init`; **A** with the plugin |
| **Config file** | `.mcp.json` (protocol) plus `plugins/claude-code` (hooks) |

Claude Code is the only host with **Tier A**: the plugin in this repo
(`plugins/claude-code`) adds a `PreToolUse` guard that denies reads of
`.env`/secret paths and env-dumping shell commands, a `UserPromptSubmit`
redactor that intercepts pasted keys, a `SessionStart` note and statusline.
Prefer the plugin. `init` does **not** claim Tier A — that is evidence-based.

## Install (protocol, Tier B)

```sh
npm install -D @envseal/cli
npx envseal init
# or:
npx envseal init --host claude-code
```

`init` writes project `.mcp.json` with `npx -y @envseal/mcp-server` and merges
`AGENTS.md`. That is protocol connected (Tier B). Restart Claude Code.

```json
{
  "mcpServers": {
    "envseal-mcp": {
      "command": "npx",
      "args": ["-y", "@envseal/mcp-server"]
    }
  }
}
```

## Install (Tier A plugin)

Install the plugin from this repo (`plugins/claude-code`,
`.claude-plugin/plugin.json`). `envseal doctor` reports `Host: Claude Code
(Tier A)` only when it can see the hooks actually installed: an envseal + hooks
entry in the project or home `.claude/settings.json` (or `settings.local.json`),
or the plugin copied under `.claude/plugins/envseal/`. With only `.mcp.json`
present, doctor reports `Claude Code (Tier B)` and `agentWiring.mcp` separately
(`ok` vs `missing`). Inside a Claude Code session (`CLAUDECODE` set), Claude
Code is detected either way, but Tier A still requires the visible hook wiring.

`--host` is an override of which files to write, not a claim about protection.
Trust `envseal doctor`.

## Notes

- Hooks deny with instructive messages — `env_describe` for status, `env_verify`
  to test a key — so the model is told what to do instead of what not to do.
- Tier A still does not defend against `env_use` exfiltration or a user who
  clicks through a confirmation dialog (see `docs/residual-risks.md`).
- The `keychain` sink remains available and recommended for long-lived, high-value
  keys even on Tier A.
