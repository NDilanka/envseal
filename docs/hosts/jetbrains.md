# JetBrains AI / IDE integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory settings |
| **Config file** | `.idea/mcp.json` (project) or IDE MCP settings |

JetBrains IDEs (IntelliJ, PyCharm, etc.) are **Tier B**: their built-in MCP
client exposes the seven tools, but nothing intercepts a shell command that
leaks a value.

One caveat: envseal's detector does not recognize JetBrains IDEs' marker files
yet, so `envseal doctor` reports `Host: Unknown Host (Tier C)`. The Tier B
label describes what the protocol binding provides on these IDEs (MCP client
plus advisory settings), not what doctor prints today — run `envseal doctor`
after setup to verify your actual tier.

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
