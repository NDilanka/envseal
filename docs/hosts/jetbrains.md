# JetBrains AI / IDE integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory settings |
| **Config file** | `.idea/mcp.json` (project) or IDE MCP settings |

JetBrains IDEs (IntelliJ, PyCharm, etc.) are **Tier B**: their built-in MCP
client exposes the seven tools, but nothing intercepts a shell command that
leaks a value.

`[VERIFY: JetBrains MCP config location/format varies by product and version —
project `.idea/mcp.json`, the shared `mcpServers` layout in IDE settings, and a
`.mcp.json` at the project root have all shipped across builds. Use the IDE's
MCP settings UI (Settings → Tools → MCP) when available; it writes the correct
file on your behalf. The snippet below is a common accepted shape.]`

## Install

`.idea/mcp.json`:

```json
{
  "mcpServers": {
    "envseal-mcp": {
      "command": "envseal-mcp"
    }
  }
}
```

Reload the project, confirm the `envseal` tool appears in the AI Assistant tool
list, then run `envseal doctor`.

## Keychain recommendation (Tier B)

JetBrains cannot stop a shell command from leaking a value. Set the `keychain`
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