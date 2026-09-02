# Codex (CLI) integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | Project `.codex/config.toml` (preferred). Global `~/.codex/config.toml` is not written |

Codex CLI is **Tier B**: it gained MCP tool support, but has no interception
hooks that can stop a leaked shell command from reaching the transcript.

Doctor recognizes a `.codex/` directory at the project root, or `CODEX_ROOT`
when there are no project markers. **`~/.codex/` alone is not Codex** — a
global install is not this project's agent, and doctor reports Unknown Host.
envseal does not write `$HOME`.

`[VERIFY: MCP support in Codex CLI is recent and the config schema is still
moving — some builds read `[mcp_servers.<name>]` from `~/.codex/config.toml`,
others use a `mcp.json` side file, and the field names (command/args) have
changed once already. Confirm the exact shape against your installed
`codex --help` / version docs. Project `.codex/` is preferred so cwd is the
workspace; if your build only reads the global file, merge the block by hand
and pass `--project` only in that global opt-in, which envseal does not write.]`

## Install

```sh
npm install -D @envseal/cli
npx envseal init
# or:
npx envseal init --host codex
```

`init` writes project `.codex/config.toml`:

```toml
[mcp_servers.envseal-mcp]
command = "npx"
args = ["-y", "@envseal/mcp-server"]
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
