# Cursor integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory rules file |
| **Config file** | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |

Cursor is **Tier B**: it speaks MCP but has no interception hooks. The rules
file (`plugins/cursor/rules/envseal.mdc`) is advisory — it reduces accidents,
it cannot block them.

## Install

```sh
mkdir -p .cursor/rules
cp plugins/cursor/mcp.json .cursor/mcp.json
cp plugins/cursor/rules/envseal.mdc .cursor/rules/
```

Project-scoped `.cursor/mcp.json`:

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

Restart Cursor, then `Settings → MCP` should show `envseal-mcp` connected.
`envseal doctor` should report `Host: Cursor (Tier B)`.

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