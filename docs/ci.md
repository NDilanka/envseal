# envseal in CI

envseal separates two jobs that interactive use blur together:

- **Provisioning** — a human declares keys and types values once, interactively, on a workstation.
- **Consumption** — a headless pipeline checks that everything it needs is present, then runs a command with the secrets injected into the child environment only.

CI is consumption. Nothing in a pipeline should ever prompt, and nothing here does: this page is the exact contract for using envseal on a runner, including what it does not do.

## The model

A pipeline cannot type a secret into a dialog, so the pipeline never provisions. Instead, the runner's own secret store (GitHub Actions secrets, GitLab CI variables, Doppler, Vault…) materializes the values the same way it always has — for the dotenv sink, by writing the `.env` file the project declares; for provider sinks, by having the provider CLI and its auth on the runner. envseal's job on top of that is the part the runner genuinely lacks: checking that what was materialized matches what the project *declared* it needs, and running the build command with those values injected into the child process environment only — never echoed, never logged, with output redacted on the way back out.

Concretely, a job has three steps:

1. **Write the secrets** from the runner's store (your responsibility — see the recipe below).
2. **Gate**: `envseal ensure --check` proves every required key declared in `env.schema.jsonc` is actually present. Missing keys fail the job in seconds with exit 1 and a JSON list of exactly what is missing.
3. **Run**: `envseal run -- <command>` executes the build with the declared keys injected into the child environment, stdout/stderr redacted of any secret substrings.

## The gate: `envseal ensure --check`

```bash
envseal ensure --check --json
```

- Never prompts — not even on a machine with a terminal. It makes no ticket request at all; this is a property of the code path, not of environment detection.
- Exit `0` when every required key is satisfied; exit `1` when any are missing.
- Optional entries are not part of the gate (`total` counts required keys only).
- A project with no `env.schema.jsonc` exits `2` (`SEP_NOT_DECLARED`) rather than reporting vacuous success.

JSON output on failure names what the pipeline needs to provision:

```json
{
  "satisfied": false,
  "keysSet": 0,
  "total": 2,
  "missing": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
}
```

## The run: `ENVSEAL_ASSUME_YES=1`

`envseal run` asks a human to confirm before injecting secrets into a child process. On a runner there is no human, so the confirmation has exactly one headless bypass: `ENVSEAL_ASSUME_YES=1` (or the `--yes` flag) pre-approves the injection.

That variable is scoped to this one confirmation by design. `ENVSEAL_ASSUME_YES` is read in exactly one place in the CLI — the `run` confirmation — and in no other command. The MCP and SDK bindings deliberately do not honour it at all: there the command comes from a model, and the confirmation dialog is the only control on it. Setting the variable on a runner therefore grants exactly "the pipeline may inject declared secrets into commands the pipeline itself runs", and nothing else.

**Treat that as a trust decision about the command, not a formality.** `envseal run -- npm test` with `ENVSEAL_ASSUME_YES=1` hands every declared secret to that `npm test` and everything it executes. Pin the command; do not feed it untrusted input.

```bash
ENVSEAL_ASSUME_YES=1 envseal run -- npm test
```

With `CI` set, anything that *would* prompt (`ensure` without `--check`, `set`, `verify` against a non-allowlisted probe host) fails immediately with `SEP_NO_INTERACTIVE_SURFACE` and exit 4 instead of hanging on a surface nobody is watching. A headless job fails in seconds with a documented code; it never blocks on a hidden dialog.

## Recipe: GitHub Actions

```yaml
name: build
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      ENVSEAL_ASSUME_YES: "1"
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      # 1. Materialize secrets from the runner's store into the file the
      #    project's manifest declares (dotenv sink). Actions masks these in
      #    logs; envseal additionally redacts them from everything it prints.
      - name: Write declared secrets
        run: |
          cat > .env <<'EOF'
          OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }}
          EOF

      # 2. Gate: fail fast, machine-checkably, if the project declares a key
      #    this job did not provide.
      - name: Check declared keys
        run: node packages/cli/dist/bin.js ensure --check --json

      # 3. Run with secrets injected into the child environment only.
      - name: Test
        run: node packages/cli/dist/bin.js run -- npm test
```

(On a project that installs envseal as a dependency, `envseal` resolves via the package bin; `node …/dist/bin.js` is the zero-dependency form.)

The same three steps translate to any other CI: write the secrets your manifest declares, `ensure --check`, `run --`.

## What envseal does NOT do in CI

Stated plainly, because a secrets tool that overstates its guarantees is worse than one that states them exactly:

- **No machine-identity authentication.** envseal does not authenticate the runner to anything and cannot fetch secrets from a provider on a pipeline's behalf. Materializing values from your secret store onto the runner is your pipeline's job (step 1 above) and stays outside envseal's boundary.
- **Provider sinks need their CLIs and auth on the runner.** `vault`, `onepassword`, `doppler`, and `sops` sinks shell out to the provider's CLI. On a runner, that means the CLI installed and a machine-appropriate token/key present (`VAULT_TOKEN`, a service account, `SOPS_AGE_KEY`, …). envseal reports the sink unavailable otherwise — it does not work around missing provider auth.
- **`.env` on the runner is still `.env`.** A plaintext file written in step 1 has the usual lifetime on the runner's disk. envseal never prints from it, redacts its values from all command output, and its own state lives in gitignored `.envseal/` — but scrubbing the runner workspace afterwards (or using an ephemeral runner, or the `sops` sink so the sidecar on disk is ciphertext) is your call, not something envseal does for you.
- **`--check` verifies presence, not validity.** It says the declared keys are satisfiable from their sinks. Whether the credentials still *work* is `envseal verify`'s job — and verification probes that hit non-allowlisted hosts need a one-time interactive approval recorded in `.envseal/approvals.json`, which you commit or stage onto the runner; there is deliberately no headless way to pre-approve sending a secret to a new host.

## Exit codes on a runner

| Code | Meaning | Typical cause in CI |
|---|---|---|
| 0 | satisfied / command succeeded | — |
| 1 | required keys missing (`--check`), or shortfall after `ensure` | step 1 didn't write a declared key |
| 2 | usage error, or no `env.schema.jsonc` | job runs in a directory without the manifest |
| 3 | cancelled | rare headless; a ticket closed unanswered |
| 4 | `SEP_NO_INTERACTIVE_SURFACE` | `ensure` (without `--check`) or `set` tried to prompt (`verify` never does: an unapproved probe reports per-key `probe_not_approved` under exit 6) |

See [docs/cli-contract.md](cli-contract.md) for the full per-command contract.
