# Host integration matrix

Which binding tier each host uses, which protection tier it gets, and where the
config lives. Every per-host page has a copy-pasteable snippet; entries marked
`[VERIFY]` should be checked against your installed version's documentation
before relying on them.

| Host | Binding tier | Protection tier | Config file |
|---|---|---|---|
| claude-code | 1 (MCP) — plus bundled hooks | **A** | `.claude-plugin/plugin.json` or `.mcp.json` |
| cursor | 1 (MCP) | **B** | `.cursor/mcp.json` or `~/.cursor/mcp.json` |
| continue | 1 (MCP) | **B** | `~/.continue/config.yaml` |
| windsurf | 1 (MCP) | **B** | `.windsurf/mcp_config.json` `[VERIFY]` |
| cline | 1 (MCP) | **B** | `.cline/mcp_settings.json` `[VERIFY]` |
| zed | 1 (MCP) | **B** | `.zed/settings.json` `[VERIFY]` |
| codex | 1 (MCP) | **B** | `~/.codex/config.toml` `[VERIFY]` |
| goose | 1 (MCP) | **C** | `~/.config/goose/config.yaml` `[VERIFY]` |
| copilot-agent | 1 (MCP) | **B** | `github.copilot.mcp` VS Code setting `[VERIFY]` |
| jetbrains | 1 (MCP) | **B** | `.idea/mcp.json` `[VERIFY]` |
| aider | 4 (CLI) | **C** | `.aider.conf.yml` + `/run` |
| openhands | 4 (CLI) | **C** | `AGENTS.md` + terminal tool `[VERIFY]` |
| shell-agent | 4 (CLI) | **C** | `AGENTS.md` / shell recipe |

## Tiers

| Tier | Meaning | Hosts |
|---|---|---|
| **A** | protocol + interception hooks (tool-call and user-message filtering) | claude-code |
| **B** | protocol + advisory guardrails (rules file, docs, pre-commit) | cursor, continue, windsurf, cline, zed, codex, copilot-agent, jetbrains |
| **C** | protocol only | goose, aider, openhands, shell-agent |

On **B** and **C** a shell command can still exfiltrate a value. The docs for
those hosts recommend the `keychain` sink so `.env` holds only
`secret-ref://envseal/...` references and no plaintext touches disk.

## MCP server command

Every MCP snippet below registers the same server, invoked as `envseal-mcp`
(the binary shipped by `@envseal/mcp-server`, a dependency of `@envseal/cli`).
Set `command` to the absolute path of `packages/mcp-server/dist/bin.js` (this
repo) when `envseal-mcp` is not on your `PATH`, and pass `--project <abs path>`
if the host does not launch MCP servers with the project root as cwd.

## Generic instruction file

For any host that reads instruction files — and for plain shell agents — start
from `plugins/generic/AGENTS.md`. It tells the agent, imperatively: never read
`.env`, never echo environment variables, use `envseal ensure` /
`envseal run --` instead.