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

Confirm the tools appear in the session, then run `envseal doctor` — it
recognizes `goose.config.yaml`, a `.goose/` directory, the global
`~/.config/goose/` directory, or `GOOSE_ROOT`, and reports
`Host: Goose (Tier C)`.

## Keychain recommendation (Tier C)

Tier C has no guardrails at all. Prefer the `keychain` sink so no plaintext
touches disk: the value goes to the OS-backed store and nothing is written to
`.env` — not even a reference. Note the sink both stores and resolves today:
`envseal run` injects a keychain-stored value just like a dotenv one:

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
delegating to its provider CLI. On Tier C prefer keychain for high-value keys
you want off disk, and dotenv when the command needs the value.