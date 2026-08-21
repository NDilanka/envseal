# Codex (CLI) integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `~/.codex/config.toml` |

Codex CLI is **Tier B**: it gained MCP tool support, but has no interception
hooks that can stop a leaked shell command from reaching the transcript.

Note that envseal's detector does not recognize Codex CLI's marker files yet,
so `envseal doctor` reports `Host: Unknown Host (Tier C)`. The Tier B label
describes what the protocol binding provides on Codex (MCP tools plus advisory
instructions), not what doctor prints today — run `envseal doctor` after setup
to verify your actual tier.

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
