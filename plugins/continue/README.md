# envseal × Continue — Tier B plugin

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory config only |
| **Files** | `config.yaml` (project snippet; global merge is manual) |

Continue is a **Tier B** host: it speaks MCP (binding tier 1) but has no
interception hooks, so a shell command that leaks a value still reaches the
transcript. The config registers the broker; it does not police anything.
MCP is **not OOTB** from `init` because Continue loads `~/.continue/config.yaml`
and envseal does not write `$HOME`.

## Install

```sh
npm install -D @envseal/cli
npx envseal init --host continue
```

1. **Layer 1.** `init` merges `AGENTS.md` so the agent can run `envseal ensure`
   / `envseal run --` without MCP.

2. **MCP (manual).** Merge the `mcpServers` block from `config.yaml` into
   `~/.continue/config.yaml`. `init` also writes a project `.continue/config.yaml`
   (detection marker + the same snippet). POSIX:

   ```yaml
   mcpServers:
     - name: envseal-mcp
       command: npx
       args: ["-y", "@envseal/mcp-server"]
   ```

   On Windows use `npx.cmd`. Do not copy this into `$HOME` via envseal; merge
   it yourself. `[VERIFY]` HUB schema vs `experimental.mcpServers`.

3. **Restart** Continue so it re-reads the global config.

4. **Verify.** `envseal doctor` reports `Host: Continue (Tier B)` from project
   `.continue/`. `agentWiring.mcp` stays `missing` until the global merge
   (not OOTB).

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
