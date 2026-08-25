# Zed integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `.zed/settings.json` (project) |

Zed is **Tier B**: it speaks MCP but has no interception hooks.

Doctor recognizes a `.zed/` directory at the project root, or `ZED_EDITOR` when
there are no project markers. A global `~/.config/zed/` / `~/.zed/` install on
a bare tree is labeled Generic Agent, not Zed. envseal does not write `$HOME`.

`[VERIFY: Zed's MCP config has changed between versions — older builds used a
`mcp` block in `settings.json`, newer ones moved toward a dedicated
`mcp` JSON file / `Zed > Settings > MCP`. Verify the key shape below against
your Zed version's documentation; the in-app MCP settings UI writes the correct
file for you.]`

## Install

```sh
npm install -D @envseal/cli
npx envseal init
# or:
npx envseal init --host zed
```

`init` merges into project `.zed/settings.json` (sibling keys are left intact):

```json
{
  "mcp": {
    "envseal-mcp": {
      "command": "npx",
      "args": ["-y", "@envseal/mcp-server"]
    }
  }
}
```

Restart Zed, confirm the server under `MCP`, then run `envseal doctor`. Doctor
warns / fails if the file has no envseal server after write (`[VERIFY]`).

## Keychain recommendation (Tier B)

Zed cannot stop a shell command from leaking a value. Set the `keychain`
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
