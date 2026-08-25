# Host integration matrix

Which binding tier each host uses, which protection tier it gets, and where the
config lives. The primary path is `npm i -D @envseal/cli` && `npx envseal init`
**in this project** (or this IDE session) — not every IDE on the PC. `init`
merges `AGENTS.md` (Layer 1) always, then writes each matching **project**
config (Layer 2). `--host <name>` is the escape hatch when detection cannot
see the IDE. Entries marked `[VERIFY]` should be checked against your installed
version's documentation before relying on them.

| Host | Binding tier | Protection tier | What `init` writes |
|---|---|---|---|
| claude-code | 1 (MCP) — plus bundled hooks | **B** OOTB, **A** with plugin | `.mcp.json` + `.claude/` marker. Plugin = A |
| cursor | 1 (MCP) | **B** | `.cursor/mcp.json` + `.cursor/rules/envseal.mdc` |
| continue | 1 (MCP) | **B** | Project `.continue/config.yaml` (copy-paste). **Not OOTB** — Continue loads `~/.continue/config.yaml`; envseal does not write `$HOME` |
| windsurf | 1 (MCP) | **B** | `.windsurf/mcp_config.json` `[VERIFY]` |
| cline | 1 (MCP) | **B** | `.cline/mcp_settings.json` `[VERIFY]` |
| zed | 1 (MCP) | **B** | `.zed/settings.json` `mcp` key `[VERIFY]` |
| codex | 1 (MCP) | **B** | Project `.codex/config.toml` `[VERIFY]` |
| goose | 1 (MCP) | **C** | Prints `goose mcp add` + yaml. **Not OOTB**. Marker `.goose/` |
| copilot-agent | 1 (MCP) | **B** | `.vscode/settings.json` `github.copilot.mcp` `[VERIFY]` + `AGENTS.md` |
| jetbrains | 1 (MCP) | **B** | `.idea/mcp.json` `[VERIFY]` |
| aider | 4 (CLI) | **C** | `.aider.conf.yml` (`read:` without `.env`) + `AGENTS.md` |
| openhands | 4 (CLI) | **B** | `AGENTS.md` only `[VERIFY]` (sandbox / TTY) |
| shell-agent | 4 (CLI) | **B** | `AGENTS.md` / shell recipe |

> **What `envseal doctor` actually detects (labeling):** claude-code, cursor,
> continue, aider, windsurf, cline, zed, codex, jetbrains, goose, and copilot
> are identified by **project-root** markers: `.claude/`, `.cursor/`,
> `.continue/`, `.windsurf/`, `.cline/`, `.zed/`, `.codex/`, `.idea/`,
> `goose.config.yaml` / `.goose/`, aider's `aider.conf.yml`-style files, and
> `copilot` settings inside `.vscode/settings.json`. Process env
> (`CLAUDECODE`, `CURSOR_*`, `CLINE_ROOT`, `ZED_EDITOR`, `CODEX_ROOT`,
> `GOOSE_ROOT`) is used only when the project has no marker of its own.
>
> `$HOME` installs are **not** this project's agent. `~/.codex/` alone does
> **not** report Codex (Unknown Host). `~/.codeium/windsurf/`, `~/.cline/`,
> `~/.config/zed/` / `~/.zed/` on a bare tree report **Generic Agent**, not a
> named host. `~/.continue/config.yaml` alone is Unknown Host. Doctor never
> writes those global files.
>
> Folder presence is not wiring. An empty `.cursor/mcp.json` is unwired
> (non-zero). JSON includes `agentWiring: { mcp, instructions }`.
> claude-code reports Tier A only with visible hook wiring; `.mcp.json` alone
> is Tier B + MCP wired/missing as a separate field.

## Tiers

| Tier | Meaning | Hosts |
|---|---|---|
| **A** | protocol + interception hooks (tool-call and user-message filtering) | claude-code (plugin) |
| **B** | protocol + advisory guardrails (rules file, docs, pre-commit) | cursor, continue, windsurf, cline, zed, codex, copilot-agent, jetbrains, openhands, shell-agent |
| **C** | protocol only | goose, aider |

On **B** and **C** a shell command can still exfiltrate a value. The docs for
those hosts recommend the `keychain` sink so no plaintext touches disk — the
value goes to the OS-backed store and nothing is written to `.env`. The keychain
sink both stores and resolves today: `envseal run` injects a keychain-stored
value just like a dotenv one.

## MCP server command

Every MCP snippet `init` writes uses the same server:

```json
{
  "command": "npx",
  "args": ["-y", "@envseal/mcp-server"]
}
```

On Windows the command is `npx.cmd`. Do not use a bare `envseal-mcp` binary:
host launchers do not search `node_modules/.bin`. Do not bake `--project` into
a committed project file. Do not recommend `~/.cursor/mcp.json` (or other
user-global MCP) as the default — those processes often start with `cwd` =
`$HOME`.

If several project markers exist, `init` writes all of them.

## Generic instruction file

Layer 1: `init` merges `plugins/generic/AGENTS.md` into project-root
`AGENTS.md`. It tells the agent, imperatively: never read `.env`, never echo
environment variables, use `envseal ensure` / `envseal run --` instead. That is
the working path for OpenHands, Aider-adjacent hosts, Copilot-without-MCP, and
unknown hosts.
