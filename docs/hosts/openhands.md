# OpenHands integration

| | |
|---|---|
| **Binding tier** | 4 — CLI contract (`envseal` subcommands) |
| **Protection tier** | **B** — protocol + advisory guardrails |
| **Config file** | `AGENTS.md` (via `plugins/generic/AGENTS.md`) + terminal tool |

OpenHands runs agents in a sandboxed environment; whether the `envseal` binary
is reachable inside that environment is a deployment decision, and interactive
prompts (`ensure`) need a way to reach the user's terminal. This makes the
integration **Tier B** and deployment-dependent. Because these setups place
`AGENTS.md` at the project root, `envseal doctor` reports
`Host: Generic Agent (Tier B)`.

`[VERIFY: OpenHands runtime/sandbox and terminal-tool configuration differ
across versions and deployments. Confirm where the agent executes commands
(host vs. sandbox) and how `envseal` is installed there before relying on the
recipe below.]`

## Install

1. Make `envseal` available where the agent's commands run
   (`npm i -g @envseal/cli`).
2. Add `plugins/generic/AGENTS.md` to the project root so OpenHands reads the
   imperative rules (never read `.env`, never echo variables, use
   `envseal ensure` / `envseal run --`).
3. Give the agent a stable interactive path for `envseal ensure` when keys are
   missing (a terminal tool or configured user interaction); otherwise
   `ensure` fails with `no interactive surface` (exit 4), which is the correct,
   explicit failure mode.

## Tier-4 usage

```
envseal status            # presence metadata, never values
envseal ensure            # prompt for missing keys (needs a user-facing terminal)
envseal run -- <cmd...>   # run with secrets injected, output redacted
envseal verify            # classified verification results
envseal doctor --json     # host + tier + config health
```

## Keychain recommendation (Tier B)

Prefer the `keychain` sink so no plaintext touches disk: the value goes to the
OS-backed store and nothing is written to `.env` — not even a reference. Note
the sink is write-only today: it stores the value, but `envseal run` cannot yet
resolve a keychain-stored value back, so use `dotenv` for keys a command must
actually receive:

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
read-back ships, `dotenv` is the only sink `envseal run` can resolve.