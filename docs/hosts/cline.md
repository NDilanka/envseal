# Cline integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `.cline/mcp_settings.json` (project) or `~/.cline/mcp_settings.json` (global) |

Cline is **Tier B**: it speaks MCP but has no interception hooks.

`[VERIFY: Cline reads `mcp_settings.json` from the project `.cline` folder (or
`~/.cline/mcp_settings.json`). The keys below match the documented schema; if
your Cline build differs, use the in-app MCP settings UI, which writes the file
for you.]`

## Install

`.cline/mcp_settings.json`:

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

Restart/reload Cline, confirm `envseal-mcp` connects, then run
`envseal doctor` to see which tier your setup actually provides.

## Keychain recommendation (Tier B)

Cline cannot stop a shell command from leaking a value. Set the `keychain`
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

Values are resolved by `envseal run -- <cmd>`; tools that read `.env` directly
cannot resolve references. On Tier B prefer keychain unless you need plaintext.