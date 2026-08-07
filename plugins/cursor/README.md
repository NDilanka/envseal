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

1. **MCP server.** Copy `mcp.json` to `.cursor/mcp.json` at your project root for
   a project-scoped server, or to `~/.cursor/mcp.json` for every project:

   ```sh
   cp plugins/cursor/mcp.json .cursor/mcp.json
   ```

   The `envseal-mcp` command must be on your `PATH` (it ships with `@envseal/mcp-server`,
   which is installed as a dependency of `@envseal/cli`). If you run from a monorepo
   checkout, point `command` at `packages/mcp-server/dist/bin.js` and add
   `"args": ["--project", "<abs path>"]` if the workspace root is not the MCP cwd.

2. **Restart the MCP servers** (Cursor: `Settings → MCP` shows the connection status).

3. **Rules.** Copy `rules/envseal.mdc` into `.cursor/rules/` (or `~/.cursor/rules/`
   to apply globally):

   ```sh
   mkdir -p .cursor/rules && cp plugins/cursor/rules/envseal.mdc .cursor/rules/
   ```

4. **Sink.** Because Cursor is Tier B, set the `keychain` sink (see below).

5. **Verify.** Run `envseal doctor` — it should report `Host: Cursor (Tier B)`.

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