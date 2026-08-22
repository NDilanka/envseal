# Shell agent integration (any agent that only runs commands)

| | |
|---|---|
| **Binding tier** | 4 — CLI contract |
| **Protection tier** | **B** — protocol + advisory guardrails |
| **Config file** | `AGENTS.md` (via `plugins/generic/AGENTS.md`) or a shell wrapper |

Any agent that can run shell commands — a `bash` runner, a custom harness, a
Devin-style job — integrates at **Tier 4**. The contract is
`docs/cli-contract.md`: every command supports `--json`, prints exactly one JSON
object on stdout, never prints a value (stdout or stderr), and exits with a
stable code. Because these setups place `AGENTS.md` at the project root,
`envseal doctor` reports `Host: Generic Agent (Tier B)`.

## Baseline snippet (bash)

```bash
#!/bin/bash
set -euo pipefail

# provision anything missing; exit 0 / 1 / 3 / 4 per docs/cli-contract.md
envseal ensure

# run tests with secrets injected into this child only (output redacted)
envseal run -- pytest -q

# machine-readable status for your own decision logic
if ! envseal status OPENAI_API_KEY >/dev/null 2>&1; then
  echo "OPENAI_API_KEY not provisioned" >&2
  exit 1
fi
```

The guard's exit-code contract assumes `OPENAI_API_KEY` is declared in
`env.schema.jsonc`: a key that is not declared does not affect the exit code,
since `status` exits nonzero only when a declared required key is missing.

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

## Keychain recommendation (Tier B)

Prefer the `keychain` sink so no plaintext touches disk: the value goes to the
OS-backed store and nothing is written to `.env` — not even a reference. Note
the sink both stores and resolves today: `envseal run` injects a keychain-stored
value just like a dotenv one:

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
read-back ships, `dotenv` is the only sink `envseal run` can resolve. On a bare
shell agent prefer keychain for high-value keys you want off disk, and dotenv
when the command needs the value.