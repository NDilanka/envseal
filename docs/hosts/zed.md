# Zed integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `.zed/settings.json` (project) or `~/.config/zed/settings.json` (global) |

Zed is **Tier B**: it speaks MCP but has no interception hooks.

One caveat: envseal's detector does not recognize Zed's marker files yet, so
`envseal doctor` reports `Host: Unknown Host (Tier C)`. The Tier B label
describes what the protocol binding provides on Zed (MCP plus advisory
instructions), not what doctor prints today — run `envseal doctor` after setup
to verify your actual tier.

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

The `sink: "keychain"` entry above is valid and stores the value; until
read-back ships, `dotenv` is the only sink `envseal run` can resolve. On Tier B
prefer keychain for high-value keys you want off disk, and dotenv when the
command needs plaintext.
