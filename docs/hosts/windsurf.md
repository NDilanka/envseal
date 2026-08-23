# Windsurf integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory rules |
| **Config file** | `.windsurf/mcp_config.json` (project) or `~/.codeium/windsurf/mcp_config.json` (global) |

Windsurf is **Tier B**: it speaks MCP but has no interception hooks.

`[VERIFY: Windsurf's MCP config schema has shifted across releases. The
`mcp_config.json` file with an `mcpServers` map below matches the Cursor-derived
schema Windsurf shipped with, but check the exact file name and keys against
your installed version's documentation before relying on it. Use the in-app
Windsurf MCP settings dialog when available — it writes the right file on
your behalf.]`

## Install

```sh
mkdir -p .windsurf
```

`.windsurf/mcp_config.json`:

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

Restart Windsurf, then confirm the server appears under MCP and run
`envseal doctor`. The detector recognizes a `.windsurf/` directory at the
project root or the global `~/.codeium/windsurf/` config directory and reports
`Host: Windsurf (Tier B)`.

## Keychain recommendation (Tier B)

Windsurf cannot stop a shell command from leaking a value. Set the `keychain`
sink to keep the value out of `.env` entirely: it is stored in the OS-backed
store and nothing is written to `.env`, not even a reference. Note the sink both
stores and resolves today — `envseal run` injects a keychain-stored value just
like a dotenv one:

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
delegating to its provider CLI. On Tier B prefer keychain for high-value keys
you want off disk, and dotenv when the command — or other tooling that reads
`.env` — needs the value.
