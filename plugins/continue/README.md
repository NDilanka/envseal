# envseal × Continue — Tier B plugin

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory config only |
| **Files** | `config.yaml` |

Continue is a **Tier B** host: it speaks MCP (binding tier 1) but has no
interception hooks, so a shell command that leaks a value still reaches the
transcript. The config registers the broker; it does not police anything.

## Install

1. **MCP server.** Merge the `mcpServers` block from `config.yaml` into
   `~/.continue/config.yaml` (or `config.json` for the JSON config).

   The `envseal-mcp` command must be on your `PATH` (it ships with
   `@envseal/mcp-server`, a dependency of `@envseal/cli`). In a monorepo checkout
   substitute `"command": "node"` + `"args": ["<abs>/packages/mcp-server/dist/bin.js"]`.

2. **Restart** Continue so it re-reads the config and connects to the server.

3. **Verify.** Run `envseal doctor` — it should report `Host: Continue (Tier B)`.

## Keychain recommendation (Tier B)

Continue cannot stop a shell command from leaking a value. Use the `keychain`
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

The value never touches disk in plaintext and is resolved by
`envseal run -- <cmd>` at launch. Tools that read `.env` directly (Docker Compose,
Next.js, Vite) cannot resolve references — weigh that against the leak risk of
Tier B.