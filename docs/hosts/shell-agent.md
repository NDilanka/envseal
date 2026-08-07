# Shell agent integration (any agent that only runs commands)

| | |
|---|---|
| **Binding tier** | 4 — CLI contract |
| **Protection tier** | **C** — protocol only |
| **Config file** | `AGENTS.md` (via `plugins/generic/AGENTS.md`) or a shell wrapper |

Any agent that can run shell commands — a `bash` runner, a custom harness, a
Devin-style job — integrates at **Tier 4**. The contract is
`docs/cli-contract.md`: every command supports `--json`, prints exactly one JSON
object on stdout, never prints a value (stdout or stderr), and exits with a
stable code.

## Baseline snippet (bash)

```bash
#!/bin/bash
set -euo pipefail

# provision anything missing; exit 1 / 3 / 4 / 5 / 6 per docs/cli-contract.md
envseal ensure

# run tests with secrets injected into this child only (output redacted)
envseal run -- pytest -q

# machine-readable status for your own decision logic
if ! envseal status --json | grep -q '"present": true, "key": "OPENAI_API_KEY"'; then
  echo "OPENAI_API_KEY not provisioned" >&2
  exit 1
fi
```

## Instruction file

Add `plugins/generic/AGENTS.md` to the project root and point the agent at it.
For most agents this is the only advisory guardrail available — it is
**advisory**, not enforced:

- never read or copy `.env` / `.env.*` (except `.env.example`);
- never `printenv`, bare `env`, `export -p`, or `echo $VAR`;
- use `envseal ensure` / `envseal run -- <cmd>` instead.

## Recommended wiring

1. Pre-command latch: `envseal ensure` before any step that needs secrets.
2. Wrap every secret-needing command: `envseal run -- <command...>`.
3. Feature-detect with exit codes, not text.

## Keychain recommendation (Tier C)

Prefer the `keychain` sink so `.env` holds only a `secret-ref://envseal/...`
reference and no plaintext touches disk:

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
cannot resolve references. On a bare shell agent the keychain sink is the
default recommendation.