# Continue integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory config only |
| **Config file** | `~/.continue/config.yaml` (or `config.json`) |

Continue is **Tier B**: it speaks MCP but has no interception hooks.
`[VERIFY: recent Continue builds moved to a new HUB config schema; if a
top-level `mcpServers` list is not accepted, use the legacy
`experimental.mcpServers` form — check your version's docs.]`

## Install

Merge into `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: envseal-mcp
    command: envseal-mcp
    args: []
```

Restart Continue so the server connects. `envseal doctor` reports
`Host: Continue (Tier B)` only when a `.continue/` directory exists at the
project root — detection does not read your global config. If your project has
none, create an empty `.continue/` directory to be detected; otherwise doctor
reports Unknown Host (Tier C).

## Keychain recommendation (Tier B)

Continue cannot stop a shell command from leaking a value. Set the `keychain`
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
read-back ships, `dotenv` is the only sink `envseal run` can resolve. Weigh
dotenv's plaintext on disk against Tier B's leak risk.