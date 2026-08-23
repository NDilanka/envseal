# Zed integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `.zed/settings.json` (project) or `~/.config/zed/settings.json` (global) |

Zed is **Tier B**: it speaks MCP but has no interception hooks.

One note on detection: `envseal doctor` recognizes a `.zed/` directory at the
project root, the global Zed config directories (`~/.config/zed/`, `~/.zed/`),
or `ZED_EDITOR`, and reports `Host: Zed (Tier B)`.

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
you want off disk, and dotenv when the command needs plaintext.
