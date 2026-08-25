# envseal × generic agent — Tier B/C plugin

| | |
|---|---|
| **Binding tier** | 4 — CLI contract |
| **Protection tier** | **C** (or B when paired with `AGENTS.md` on a compliant agent) |
| **Files** | `AGENTS.md`, `pre-commit` |

For agents that only speak shell — custom runners, plain `bash` loops, agents
whose harness you cannot configure — envseal integrates at **Tier 4**, the CLI
contract: `envseal <subcommand> --json`, documented exit codes, no secret value
ever printed.

These two files are the generic drop-in:

- **`AGENTS.md`** — `npx envseal init` merges this into your project's
  `AGENTS.md` (create or append; never clobbers unrelated content). It tells any
  agent, in imperative form, to never read `.env`, never echo variables, and to
  use `envseal ensure` / `envseal run --` instead.
- **`pre-commit`** — a dependency-free POSIX `sh` git hook (only `git`, `grep`,
  `sed`-free: `basename`, `mktemp`) that refuses a commit staging `.env` or a
  secret-shaped value.

## Install

```sh
npm install -D @envseal/cli
npx envseal init
# Layer 1 only on a bare tree; or:
npx envseal init --host generic
```

Optional pre-commit hook:

```sh
install -m 0755 plugins/generic/pre-commit .git/hooks/pre-commit
```

## Usage

```sh
envseal ensure                    # prompt for every missing required key
envseal status --json             # machine-readable presence metadata
envseal run -- <command...>       # run with secrets injected, output redacted
envseal verify --json             # classified verification results
envseal doctor --json             # host tier, agentWiring, gitignore, missing keys
```

`AGENTS.md` is an advisory guardrail: an agent that ignores instructions can
still leak. That is why this tier is **C** unless your agent is known to obey
instruction files reliably.

## Keychain recommendation (Tier B/C)

With no interception hooks, prefer the `keychain` sink so `.env` holds only a
`secret-ref://envseal/...` reference and plaintext never touches disk:

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
directly cannot resolve them; on a generic host with only advisory guardrails,
the leak risk almost always outweighs that convenience.
