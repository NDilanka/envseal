# Codex (CLI) integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `~/.codex/config.toml` |

Codex CLI is **Tier B**: it gained MCP tool support, but has no interception
hooks that can stop a leaked shell command from reaching the transcript.

Note on detection: `envseal doctor` recognizes a `.codex/` directory at the
project root, the global `~/.codex/` config directory, or `CODEX_ROOT`, and
reports `Host: Codex CLI (Tier B)`.

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
