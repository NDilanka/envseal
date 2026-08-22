# Aider integration

| | |
|---|---|
| **Binding tier** | 4 — CLI contract (`envseal` subcommands) |
| **Protection tier** | **C** — protocol only |
| **Config file** | `.aider.conf.yml` + `/run` recipe |

Aider has no MCP client, so it integrates at **Tier 4** via the `envseal`
binary. Nothing intercepts leaks, and Aider *renders every file it reads into
the chat context* — so a single `cat .env` is immediately catastrophic. This
integration is written around that.

## Install

Copy `plugins/aider/.aider.conf.yml` (or merge the two lines below into your
config):

```yaml
# .aider.conf.yml — NEVER add `.env` or `.env.*` to `read`
read:
  - env.schema.jsonc
  - .env.example
```

The `read` list is the guardrail: only declaration and placeholder files are
ever brought into context.

## Tier-4 usage (Aider `/run`)

```
/run envseal status             # which declared keys are present
/run envseal ensure             # prompt the user for every missing key
/run envseal run -- pytest     # run with secrets injected, output redacted
/run envseal verify             # test keys end-to-end
/run envseal doctor             # host + tier + config health
```

`envseal ensure` and `envseal run --` are the *only* ways to obtain or use
secret values inside Aider.

## Keychain recommendation (Tier C)

Tier C has no guardrails. Prefer the `keychain` sink to keep the value out of
`.env` entirely: it is stored in the OS-backed store and nothing is written to
`.env`, not even a reference. Note the sink both stores and resolves today —
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

The `sink: "keychain"` entry above is valid and stores the value; until
read-back ships, `dotenv` is the only sink `envseal run` can resolve. On Aider
prefer keychain for high-value keys you want off disk, and dotenv when the
command needs the value.