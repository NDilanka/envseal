# envseal × Aider — Tier C plugin

| | |
|---|---|
| **Binding tier** | 4 — CLI contract |
| **Protection tier** | **C** — protocol only |
| **Files** | `.aider.conf.yml` |

Aider does not expose an MCP client, so it integrates at **Tier 4**: the
`envseal` CLI, JSON output, stable exit codes. There is no interception layer and
no enforced guardrail, which makes Aider a **Tier C** host — the protocol is
structurally sound, but nothing outside it stops a leaked value from reaching the
transcript.

Aider also *renders every file it reads into the chat context*. That makes a
single mistake — `cat .env`, or adding `.env` to the `read` list — immediately
catastrophic. The config and recipe below are written around that fact.

## Install

```sh
npm install -D @envseal/cli
npx envseal init --host aider
```

`init` merges Layer 1 `AGENTS.md` and this `.aider.conf.yml` so `.env` is not
on `read:`. Re-running is idempotent and will strip `.env` from an existing
`read` list.

In an Aider session, use the `/run` command:

```
/run envseal ensure
/run envseal run -- pytest
/run envseal doctor
```

## Shell recipe (for hooks, scripts, CI)

The same contract is usable outside Aider — e.g. in a pre-commit or a `Makefile`:

```bash
#!/bin/bash
set -e
envseal ensure        # exit 0 = all required keys present
envseal run -- npm test   # secrets injected into this child only
```

Machine contract: `envseal --json` prints exactly one JSON object; exit codes are
`0` ok, `1` missing keys, `2` usage, `3` cancelled, `4` no interactive surface,
`5` sink failure, `6` verification failed (see `docs/cli-contract.md`).

## Keychain recommendation (Tier C)

Tier C has no guardrails at all. Use the `keychain` sink so `.env` holds only a
`secret-ref://envseal/...` reference and no plaintext ever touches disk:

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

References are resolved by `envseal run -- <cmd>`. Tools that read `.env`
directly cannot resolve references; on Aider, prefer the `keychain` sink unless
you specifically need a plaintext `.env` for other tooling.
