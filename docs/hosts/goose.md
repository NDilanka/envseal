# Goose integration

| | |
|---|---|
| **Binding tier** | 1 — MCP over stdio |
| **Protection tier** | **C** — protocol only |
| **Config file** | `~/.config/goose/config.yaml` |

Goose is a **Tier C** host: it speaks MCP, but this integration provides no
interception hooks and no interrogated advisory layer, so the guarantee is the
protocol itself and nothing more.

`[VERIFY: Goose's config and extension-registration format have changed
between releases, and the project recommends registering MCP servers with its
own CLI rather than hand-editing config. Prefer the in-app command — e.g.
`goose mcp add` (check your build's help) — over the yaml below, which matches
one published shape of `~/.config/goose/config.yaml` and may not match yours.]`

## Install

```sh
goose mcp add envseal-mcp -- envseal-mcp   # [VERIFY: exact flags for your build]
```

or, if hand-editing `~/.config/goose/config.yaml`:

```yaml
mcp:
  servers:
    envseal-mcp:
      cmd: envseal-mcp
```

Confirm the tools appear in the session, then run `envseal doctor`.

## Keychain recommendation (Tier C)

Tier C has no guardrails at all. Prefer the `keychain` sink so `.env` holds
only a `secret-ref://envseal/...` reference and no plaintext touches disk:

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

Values are resolved by `envseal run -- <cmd>`; tools that read `.env` directly
cannot resolve references. On Tier C the keychain sink is the default
recommendation.