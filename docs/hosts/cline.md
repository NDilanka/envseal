# Cline integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `.cline/mcp_settings.json` (project) |

Cline is **Tier B**: it speaks MCP but has no interception hooks.

`[VERIFY: Cline reads `mcp_settings.json` from the project `.cline` folder (or
`~/.cline/mcp_settings.json`). The keys below match the documented schema; if
your Cline build differs, use the in-app MCP settings UI, which writes the file
for you.]`

## Install

```sh
npm install -D @envseal/cli
npx envseal init
# or:
npx envseal init --host cline
```

`init` writes project `.cline/mcp_settings.json`. It does not write `~/.cline/`.
A global `~/.cline/` install on a bare tree is labeled Generic Agent, not Cline.

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

Restart/reload Cline, confirm `envseal-mcp` connects, then run
`envseal doctor`. The detector recognizes a `.cline/` directory at the project
root, or `CLINE_ROOT` when there are no project markers. Doctor fails if the
project file has no `envseal-mcp`.

## Keychain recommendation (Tier B)

Cline cannot stop a shell command from leaking a value. Set the `keychain`
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
