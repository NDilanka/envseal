# JetBrains AI / IDE integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory settings |
| **Config file** | `.idea/mcp.json` (project) |

JetBrains IDEs (IntelliJ, PyCharm, etc.) are **Tier B**: their built-in MCP
client exposes the seven tools, but nothing intercepts a shell command that
leaks a value.

Doctor recognizes the `.idea/` project directory and reports `Host: JetBrains
IDE (Tier B)`. Folder presence is not wiring: doctor fails if `.idea/mcp.json`
has no `envseal-mcp`.

`[VERIFY: JetBrains MCP config location/format varies by product and version —
project `.idea/mcp.json`, the shared `mcpServers` layout in IDE settings, and a
`.mcp.json` at the project root have all shipped across builds. Use the IDE's
MCP settings UI (Settings → Tools → MCP) when available; it writes the correct
file on your behalf. The snippet below is a common accepted shape.]`

## Install

```sh
npm install -D @envseal/cli
npx envseal init
# or:
npx envseal init --host jetbrains
```

`init` merges project `.idea/mcp.json`:

```json
{
  "mcpServers": {
    "envseal-mcp": {
      "command": "npx",
      "args": ["-y", "@envseal/mcp-server"]
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

The `sink: "keychain"` entry above is valid and — as noted above — resolves
too, as do the provider sinks (`vault`, `1password`, `doppler`, `sops`), each
delegating to its provider CLI. On Tier B prefer keychain for high-value keys
you want off disk, and dotenv when the command needs plaintext.
