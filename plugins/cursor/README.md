# envseal × Cursor — Tier B plugin

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **B** — protocol + advisory rules file (not enforced) |
| **Files** | `mcp.json`, `rules/envseal.mdc` |

Cursor is a **Tier B** host: it speaks MCP (binding tier 1) but has no interception
hooks, so shell commands can still exfiltrate a value. The `.mdc` rules file is
advisory — it reduces accidents, it cannot block them.

## Install

```sh
npm install -D @envseal/cli
npx envseal init
# or: npx envseal init --host cursor
```

That is the primary path. `init` writes project-scoped `.cursor/mcp.json` and
`.cursor/rules/envseal.mdc`. Do not copy these files by hand, and do not put
envseal in `~/.cursor/mcp.json` — Cursor launches that process with `cwd` =
your home directory, which is not a project.

1. **MCP server.** `envseal init` merges this snippet (POSIX shown; Windows
   gets `"command": "npx.cmd"`). Cursor does not use `node_modules/.bin`, so
   `npx -y @envseal/mcp-server` is the launch that works without a global
   install. `--project` is not written: project MCP already has the workspace
   as cwd.

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

`init` always merges Layer 1 `AGENTS.md`. Reload MCP (`Settings → MCP` shows the
connection status). `envseal doctor` reports `Host: Cursor (Tier B)` and fails if
`envseal-mcp` is missing from `.cursor/mcp.json`. Re-run `envseal init` to merge
it.

From a monorepo checkout you can point `command` at
`node` + `packages/mcp-server/dist/bin.js` instead of npx; `init` will not
overwrite that customization.

## Keychain recommendation (Tier B)

A Tier B host cannot stop a shell command from leaking a value. Use the `keychain`
sink so `.env` holds only a `secret-ref://envseal/...` reference and the value never
touches disk in plaintext:

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

References are resolved when a command runs via `envseal run -- <cmd>`.
Note: tools that read `.env` directly (Docker Compose, Next.js, Vite) cannot resolve
references — for those, weigh the leak risk of Tier B against the convenience of the
`dotenv` sink.
