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
`envseal doctor`. envseal's detector does not recognize Cline's marker files
yet, so it reports `Host: Unknown Host (Tier C)`; the Tier B label describes
what the protocol binding provides on Cline (MCP plus advisory instructions),
not what doctor prints today.

## Keychain recommendation (Tier B)

Cline cannot stop a shell command from leaking a value. Set the `keychain`
sink to keep the value out of `.env` entirely: it is stored in the OS-backed
store and nothing is written to `.env`, not even a reference. Note the sink is
write-only today — `envseal run` cannot yet resolve a keychain-stored value
back — so use `dotenv` for keys a command must actually receive:

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
