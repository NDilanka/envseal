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
`envseal doctor` — it should report `Host: unknown` or a detected host; either
way verify the tier your rules actually provide.

## Keychain recommendation (Tier B)

Windsurf cannot stop a shell command from leaking a value. Set the `keychain`
sink so `.env` holds only a `secret-ref://envseal/...` reference:

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

Values are resolved by `envseal run -- <cmd>`. Tools that read `.env` directly
cannot resolve references; on Tier B prefer keychain unless you need plaintext
for other tooling.