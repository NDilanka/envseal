# Codex (CLI) integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `~/.codex/config.toml` |

Codex CLI is **Tier B**: it gained MCP tool support, but has no interception
hooks that can stop a leaked shell command from reaching the transcript.

`[VERIFY: MCP support in Codex CLI is recent and the config schema is still
moving — some builds read `[mcp_servers.<name>]` from `~/.codex/config.toml`,
others use a `mcp.json` side file, and the field names (command/args) have
changed once already. Confirm the exact shape against your installed
`codex --help` / version docs.]`

## Install

`~/.codex/config.toml`:

```toml
[mcp_servers.envseal-mcp]
command = "envseal-mcp"
```

Run `codex` in the project directory, confirm the `envseal-*` tools appear in
the tool list, then run `envseal doctor`.

## Keychain recommendation (Tier B)

Codex cannot stop a shell command from leaking a value. Set the `keychain`
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