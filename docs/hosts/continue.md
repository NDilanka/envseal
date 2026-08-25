# Continue integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory config only |
| **Config file** | `~/.continue/config.yaml` (global) — **not OOTB** |

Continue is **Tier B**: it speaks MCP but has no interception hooks.
`[VERIFY: recent Continue builds moved to a new HUB config schema; if a
top-level `mcpServers` list is not accepted, use the legacy
`experimental.mcpServers` form — check your version's docs.]`

## Install

```sh
npm install -D @envseal/cli
npx envseal init
# or:
npx envseal init --host continue
```

`init` always writes Layer 1 `AGENTS.md`. For Continue it also creates project
`.continue/config.yaml` (a copy-paste snippet) so doctor can **detect** the
host. Continue currently loads MCP from `~/.continue/config.yaml`. envseal does
**not** write that global file (cwd hazard). Merge this block yourself:

```yaml
mcpServers:
  - name: envseal-mcp
    command: npx
    args: ["-y", "@envseal/mcp-server"]
```

On Windows use `npx.cmd`. Doctor reports `Host: Continue (Tier B)` only when a
`.continue/` directory exists at the project root — detection does not read
your global config. MCP is **not OOTB**: `agentWiring.mcp` stays `missing`
until you merge the global file (envseal will not do it). Layer 1 `AGENTS.md`
is the working path.

## Keychain recommendation (Tier B)

Continue cannot stop a shell command from leaking a value. Set the `keychain`
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
delegating to its provider CLI. Weigh dotenv's plaintext on disk against
Tier B's leak risk.
