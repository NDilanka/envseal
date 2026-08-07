# Zed integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `.zed/settings.json` (project) or `~/.config/zed/settings.json` (global) |

Zed is **Tier B**: it speaks MCP but has no interception hooks.

`[VERIFY: Zed's MCP config has changed between versions — older builds used a
`mcp` block in `settings.json`, newer ones moved toward a dedicated
`mcp` JSON file / `Zed > Settings > MCP`. Verify the key shape below against
your Zed version's documentation; the in-app MCP settings UI writes the correct
file for you.]`

## Install

`.zed/settings.json` (or `~/.config/zed/settings.json`):

```json
{
  "mcp": {
    "envseal-mcp": {
      "command": "envseal-mcp"
    }
  }
}
```

Restart Zed, confirm the server under `MCP`, then run `envseal doctor`.

## Keychain recommendation (Tier B)

Zed cannot stop a shell command from leaking a value. Set the `keychain`
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