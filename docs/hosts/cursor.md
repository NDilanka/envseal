# Cursor integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory rules file |
| **Config file** | `.cursor/mcp.json` (project only) |

Cursor is **Tier B**: it speaks MCP but has no interception hooks. The rules
file (written to `.cursor/rules/envseal.mdc`) is advisory — it reduces accidents,
it cannot block them.

## Install

```sh
npm install -D @envseal/cli
npx envseal init
# or, if this project has no `.cursor/` marker yet:
npx envseal init --host cursor
```

`init` merges Layer 1 `AGENTS.md`, merges `envseal-mcp` into **project**
`.cursor/mcp.json` (other MCP servers are left intact), and copies the advisory
rules file if it is absent. It never writes `~/.cursor/mcp.json`: Cursor starts
a user-global MCP server with `cwd` set to the home directory, and `envseal-mcp`
then exits with `no project found`.

Reload MCP in **Settings → MCP**. `envseal doctor` reports `Host: Cursor
(Tier B)` and fails if `.cursor/mcp.json` has no `envseal-mcp`.

Project-scoped `.cursor/mcp.json` (POSIX). On Windows, `envseal init` writes
`"command": "npx.cmd"` instead of `"npx"` — Cursor does not search
`node_modules/.bin`, so a bare `envseal-mcp` command will not start.

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

## Keychain recommendation (Tier B)

A Tier B host cannot stop a shell command from leaking a value. Set the
`keychain` sink so plaintext never touches disk: the value goes to the OS-backed
store and nothing is written to `.env` — not even a reference. Note the sink
both stores and resolves today: `envseal run` injects a keychain-stored value
just like a dotenv one:

```jsonc
{
  "entries": [
    {
      "key": "OPENAI_API_KEY",
      "sink": "keychain"
    }
  ]
}
```

The `sink: "keychain"` entry above is valid and — as noted above — resolves
too, as do the provider sinks (`vault`, `1password`, `doppler`, `sops`), each
delegating to its provider CLI. What still holds: `dotenv` is the only sink
tools that read `.env` directly (Docker Compose, Next.js, Vite) will ever see.
On Cursor the leak risk usually outweighs that convenience.
