# GitHub Copilot Agent integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory instructions |
| **Config file** | `github.copilot.mcp` VS Code setting, plus `AGENTS.md` |

Copilot (VS Code Copilot Chat / Copilot CLI agent) is **Tier B**: it reads
`AGENTS.md` instruction files — which is the advisory guardrail — and recent
builds expose MCP tools.

`[VERIFY: the MCP wiring for Copilot agent is actively changing. In VS Code it
is the `github.copilot.mcp` setting (array of tool configs); the CLI/agent uses
`AGENTS.md` plus, in some builds, a `COPILOT_MCP_REGISTRY` env var listing
`all,<server-id>` style entries. Verify the exact key names against your
VS Code/Copilot version's documentation.]`

## Install

VS Code `settings.json`:

```json
{
  "github.copilot.mcp": [
    {
      "name": "envseal-mcp",
      "command": "envseal-mcp",
      "args": []
    }
  ]
}
```

And, for every Copilot surface, add the instruction file
(`plugins/generic/AGENTS.md`) to your project root — Copilot reads `AGENTS.md`
by default. This is the advisory layer that makes Copilot defensibly `B`.
`envseal doctor` reports `Host: GitHub Copilot (Tier B)` when
`.vscode/settings.json` mentions Copilot (the `github.copilot.*` settings
above qualify). Copilot has no unique project directory of its own, so without
that settings marker doctor falls through to `Host: Generic Agent (Tier B)`
via the `AGENTS.md` file above.

## Keychain recommendation (Tier B)

Copilot cannot stop a shell command from leaking a value. Set the `keychain`
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