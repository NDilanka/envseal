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

Restart Continue so the server connects; `envseal doctor` should report
`Host: Continue (Tier B)`.

## Keychain recommendation (Tier B)

Continue cannot stop a shell command from leaking a value. Set the `keychain`
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
cannot resolve references; weigh that against Tier B's leak risk.