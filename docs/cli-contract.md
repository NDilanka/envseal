# envseal CLI Contract — Tier 4 Integration

**This is the machine-readable contract for shell-only agents.** Every command exits with a documented exit code and prints only JSON (with `--json`) or human-readable output. No secret value ever appears in stdout or stderr, including on error paths.

## Exit Codes

| Exit Code | Name | Meaning | Retriable |
|-----------|------|---------|-----------|
| 0 | `OK` | Success | — |
| 1 | `UNSATISFIED` | One or more required keys are missing | Yes* |
| 2 | `USAGE` | Invalid usage or missing required argument | No |
| 3 | `CANCELLED` | User cancelled the operation | Yes |
| 4 | `NO_SURFACE` | No interactive prompt surface available (e.g., CI) | Yes |
| 5 | `SINK_FAILURE` | Failed to read from or write to the configured sink | Yes |
| 6 | `VERIFY_FAILED` | Verification probe failed | Yes |
| 7 | `AUDIT_CHAIN_FAILED` | Audit log hash chain failed verification (`audit --verify`) | No |

*UNSATISFIED is retriable in the sense that running `ensure` again may succeed if the user provides the keys.

## Headless Mode: the `CI` Environment Variable

Setting `CI` — to any value, including the empty string — puts envseal in headless mode. Commands that would otherwise prompt (`ensure`, `set`, the `run` confirmation) fail immediately with `SEP_NO_INTERACTIVE_SURFACE` and exit code 4 instead of blocking on a surface nobody is watching. A headless pipeline therefore fails in seconds with a documented code; it never hangs on a hidden prompt.

The one way to proceed headlessly is `envseal run`'s own confirmation bypass: `--yes` or `ENVSEAL_ASSUME_YES=1` pre-approves injecting secrets into the child process. No other binding honours it — over MCP the command comes from the model, and that confirmation is the only control on it (see [`run` confirmation](#run-confirmation)).

`ensure --check` is the headless counterpart of prompting: it never requests anything, so it needs neither a surface nor a bypass — it reports satisfaction and exits 0/1. The full pipeline recipe (gate, run, and what envseal deliberately does not do on a runner) is [docs/ci.md](ci.md).

## Commands

### `envseal init [--host <name>]`

Initialize `env.schema.jsonc` at the project root.

**Flags:**
- `--host <name>` — Override host detection. Valid values: `claude-code`, `cursor`, `continue`, `aider`, `windsurf`, `cline`, `zed`, `codex`, `jetbrains`, `goose`, `copilot`, `generic`, `unknown`; anything else is rejected with exit 2. When an override is given, the reported tier is what that host id implies, not evidence about this project — `envseal doctor` reports what is actually detected.
- `--json` — Output as JSON.
- `--project <path>` — Project root (default: auto-detect).

**JSON output:**
```json
{
  "manifestPath": "/path/to/env.schema.jsonc",
  "host": "claude-code",
  "protectionTier": "C",
  "scanned": 14,
  "added": ["OPENAI_API_KEY"],
  "updated": [],
  "unchanged": [],
  "secretKeys": ["OPENAI_API_KEY"],
  "configKeys": [],
  "entries": 1
}
```

`host` is the detected host id (`"unknown"` when nothing matched); `protectionTier` is `"A"`, `"B"`, or `"C"`; `scanned` is the number of files scanned; `added`/`updated`/`unchanged` list the manifest entries by outcome; `secretKeys`/`configKeys` split the declared keys by their `secret` flag; `entries` is the total entry count.

**Exit codes:** Always 0 on success.

---

### `envseal ensure [--check]`

Prompt for every missing required key in one pass.

**Flags:**
- `--check` — Never prompt, even interactively. Report whether every required key is satisfied and exit 0 (satisfied) or 1 (missing). This is the CI gate: it makes no ticket request at all, so it cannot block on a surface nobody is watching and works with `CI` set. Optional entries are not part of the gate — `total` counts required keys only.
- `--json` — Output as JSON.
- `--project <path>` — Project root.

**JSON output:**
```json
{
  "satisfied": true,
  "keysSet": 3,
  "total": 3
}
```

With `--check`, the JSON names what a pipeline needs to provision:
```json
{
  "satisfied": false,
  "keysSet": 0,
  "total": 2,
  "missing": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
}
```
(`keysSet`/`total` mean required keys present / required keys declared — not, as in the prompting mode, keys stored by this run / keys requested by it.)

**Exit codes:**
- 0 — All required keys are present.
- 1 — One or more required keys are still missing after the operation (with `--check`: still missing, full stop).
- 2 — No `env.schema.jsonc` in this project.
- 3 — User cancelled.
- 4 — No interactive surface available (never happens with `--check`).

---

### `envseal set <KEY>`

Prompt for a single key.

**Flags:**
- `--json` — Output as JSON.
- `--project <path>` — Project root.

**JSON output:**
```json
{
  "key": "OPENAI_API_KEY",
  "outcome": "stored"
}
```

**`outcome` values:** `stored`, `skipped`, `cancelled`, `invalid_format`, `verify_failed`, `timeout`.

**Exit codes:**
- 0 — Key stored successfully.
- 1 — Key not stored.
- 2 — Invalid arguments (no KEY provided).
- 3 — User cancelled.
- 4 — No interactive surface.

---

### `envseal status [KEY...]`

Show the status of environment keys. Do not show values.

On a project with no `env.schema.jsonc` at all, `status` is a truthful empty
report: exit 0 with zero entries. (An *audit* — `doctor` — refuses instead,
because an audit that reports "all clear" for an unconfigured project lies.)

Presence is resolved sink-aware: process environment first, then the entry's
declared sink (`dotenv` reads `.env`; `keychain` consults the OS-backed store).
A stored keychain credential therefore reports `present: true`, and `envseal
run` resolves it like any other sink. If a credential store errors while being
read (locked keychain, DPAPI failure), presence degrades to `present: false`
rather than failing the report.

**Arguments:**
- `KEY` (optional, repeatable) — Show status only for these keys. Without arguments, show all.

**Flags:**
- `--json` — Output as JSON.
- `--project <path>` — Project root.

**Human output example:**
```
✓ OPENAI_API_KEY
✗ DATABASE_URL
✓ STRIPE_SECRET_KEY
```

**JSON output:**
```json
{
  "entries": [
    {
      "key": "OPENAI_API_KEY",
      "present": true,
      "sink": "dotenv",
      "formatValid": true,
      "lengthBucket": "48-64",
      "fingerprint": "fp_9a4c1e7b",
      "lastVerified": "2026-08-07T09:12:00Z",
      "verifyResult": "ok"
    }
  ]
}
```

**Exit codes:**
- 0 — All keys are present (or no required keys exist).
- 1 — One or more required keys are missing.

---

### `envseal verify [KEY...]`

Run verification probes. Returns a classified result per key without showing response bodies.

**Arguments:**
- `KEY` (optional, repeatable) — Verify only these keys. Without arguments, verify all.

**Flags:**
- `--json` — Output as JSON.
- `--project <path>` — Project root.

**Human output example:**
```
✓ OPENAI_API_KEY: ok
✗ DATABASE_URL: auth_failed
```

**JSON output:**
```json
{
  "results": [
    {
      "key": "OPENAI_API_KEY",
      "result": "ok",
      "message": "Verified successfully"
    },
    {
      "key": "DATABASE_URL",
      "result": "auth_failed",
      "message": "Invalid credentials"
    }
  ],
  "allOk": false
}
```

**Verification results:**
- `ok` — Probe succeeded.
- `auth_failed` — Authentication failed (likely invalid key).
- `forbidden` — Access forbidden.
- `rate_limited` — Rate limited by provider.
- `network_error` — Network connectivity issue.
- `no_probe` — No probe configured for this key.
- `probe_not_approved` — Probe host is not approved.

**Exit codes:**
- 0 — All probes passed.
- 6 — One or more probes failed.

---

### `envseal run -- <cmd...>`

Execute a command with secrets injected into the child process environment only.

**Arguments:**
- `--` — Required. Everything after `--` is the command to run.

**Flags:**
- `--json` — Output exit code and redacted stdout/stderr as JSON (child output not printed).
- `--project <path>` — Project root.

**Example:**
```bash
envseal run -- npm test
```

**JSON output:**
```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "redactedCount": 0
}
```

`redactedCount` is the number of masking replacements made in the captured stdout/stderr combined (occurrences, not distinct secrets).

**Exit codes:**
- (passthrough) — Exit code of the child process.
- 2 — Invalid usage (no `--` provided).

---

### `envseal doctor`

Audit the project configuration. Reports: project root, manifest path, detected host + tier + recommendation, gitignore coverage, file permissions, effective egress policy, count of missing required keys.

With no `env.schema.jsonc` in the project there is nothing to audit: `doctor`
fails with `SEP_NOT_DECLARED` and exit 2 (same as `ensure`) instead of printing
an empty bill of health.

**Flags:**
- `--json` — Output as JSON.
- `--project <path>` — Project root.

**Human output example:**
```
Project root: /Users/alice/myproject
Host: Claude Code (Tier A)
  Found .claude/ directory
  Tier A host with full protocol + interception hooks. Secrets are maximally protected.
Gitignore covers .env: yes
Egress policy: warn (default)
Missing required keys: 1
  - OPENAI_API_KEY
```

`Egress policy:` reads `allowlist (N allowed hosts)` when the manifest sets
`policy.egress.mode: "allowlist"`, otherwise `warn (default)`.

**JSON output:**
```json
{
  "projectRoot": "/Users/alice/myproject",
  "manifestPath": "/Users/alice/myproject/env.schema.jsonc",
  "host": {
    "id": "claude-code",
    "name": "Claude Code",
    "tier": "A",
    "reason": "Found .claude/ directory",
    "recommendation": "Tier A host with full protocol + interception hooks. Secrets are maximally protected."
  },
  "gitignore": {
    "exists": true,
    "covers": true
  },
  "envFile": {
    "exists": true,
    "isTracked": false,
    "permissionsOk": true
  },
  "egressPolicy": { "mode": "warn", "allow": [] },
  "missingRequiredCount": 1,
  "missingRequired": ["OPENAI_API_KEY"]
}
```

**Exit codes:**
- 0 — All checks passed; no missing required keys.
- 1 — One or more required keys are missing.

---

### `envseal revoke <KEY>`

Remove a key from the sink and report the provider's rotation URL.

**Arguments:**
- `KEY` — The key to revoke.

**Flags:**
- `--json` — Output as JSON.
- `--project <path>` — Project root.

**JSON output:**
```json
{
  "key": "OPENAI_API_KEY",
  "removed": true,
  "rotateUrl": "https://platform.openai.com/api-keys"
}
```

`removed` is whether anything was actually removed from the sink; `rotateUrl` is null when the provider registry has no rotation URL for the key.

**Exit codes:**
- 0 — Key revoked successfully.
- 1 — Revocation failed or key not found.
- 2 — Invalid usage (no KEY provided).

---

### `envseal mcp`

Start the MCP server over stdio. Intended for integration with MCP-capable hosts (Claude Code, Cursor, etc.). Do not use this directly; the host will manage it.

**Tools exposed** (each maps to a CLI counterpart, but the host calls these directly):

| Tool | CLI equivalent | What it does |
|---|---|---|
| `env_declare` | `init` (scanner-driven) | Declare keys + metadata into `env.schema.jsonc`; secret-shaped free text is rejected (`SEP_VALUE_IN_REQUEST`) |
| `env_describe` | `status` | Presence, sink, fingerprint per key — never values |
| `env_request` | `set` | Open the secure input surface for the user to type a value; returns a ticket immediately |
| `env_await` | — (blocking part of `set`) | Poll/block on a ticket until stored / cancelled / invalid_format / timeout |
| `env_verify` | `verify` | Classified probe result (ok / auth_failed / forbidden / rate_limited / network_error / no_probe / probe_not_approved); response bodies never returned |
| `env_use` | `run` | Execute a command with secrets injected into the child environment only; output redacted; requires confirmation |
| `env_revoke` | `revoke` | Remove from sink + return the provider's rotation URL |

**Exit codes:**
- The exit code of the `envseal-mcp` child process.
- 5 — The server binary could not be started (not installed, not on PATH, or
  not executable). A failure here is never reported as success.

---

### `envseal audit [--verify]`

Print the project's audit log (`.envseal/audit.jsonl`) — provisioning events
plus every `env_use` execution attempt and its result. Works without a
manifest; a missing log prints "No audit events recorded." and exits 0.

| Flag | Effect |
|---|---|
| *(none)* | Human-readable event lines in log order |
| `--json` | The parsed event array as a single JSON array |
| `--verify` | Check the tamper-evidence hash chain instead of listing events |

With `--json --verify`, stdout is one JSON object: `{ok: true, count: N}` when
intact, `{ok: false, brokenAt: K, count: N}` otherwise.

**Exit codes:**
- 0 — chain intact (or no log: intact with zero records)
- 7 — `AUDIT_CHAIN_FAILED`: records were edited, deleted, reordered, or
  spliced after the fact. Every record after the break is untrusted.

**Honest boundary:** the chain proves surviving records are intact and
ordered; it cannot detect deletion of the log *tail*, because nothing outside
the log records how many records should exist. An agent that can run
arbitrary shell can also delete the whole file — this is tamper *evidence*,
not immutability (see docs/residual-risks.md).

---

## Global Flags

- `--project <path>` — Project root. Default: auto-detect by searching upward for `env.schema.jsonc`.
- `--json` — Output as JSON instead of human text. When set, output is **exactly one JSON object** to stdout; errors are reported as `{ code, userMessage, retriable }`.
- `--help, -h` — Show help.
- `--version, -v` — Show version.

---

## Error Response Format (JSON mode)

When `--json` is set and an error occurs:

```json
{
  "code": "SEP_FORMAT_INVALID",
  "userMessage": "The supplied value does not match the declared format.",
  "retriable": true
}
```

The `code` is from the SEP/1 specification error codes. The `userMessage` is always safe to display to the user and never contains a secret value. The `retriable` flag indicates whether retrying the operation may succeed.

Since 0.1.3, `env_use` approval binds to file **content**: every argument naming a readable file is SHA-256 fingerprinted before the confirmation dialog opens (the dialog shows path + fingerprint), and every fingerprint is re-verified against fresh disk content immediately before spawn. A mismatch returns `SEP_TARGET_CHANGED` with nothing executed — a script rewritten between "the user read the dialog" and "the command ran" does not run.

---

## Security Guarantees

1. **No command ever prints a secret value** to stdout or stderr, including under `--verbose` or on error paths.
2. **All output is filtered through the redactor**, which masks secret substrings as `«redacted:KEY_NAME»`.
3. **JSON output is single objects**, never newline-delimited, so parsing is unambiguous.
4. **Exit codes are stable and documented** so shell scripts can automate decision-making without parsing text.

---

## Integration Example (Shell Script)

```bash
#!/bin/bash
set -e

PROJECT_DIR="/path/to/myproject"

# Ensure all required keys are set
envseal --project "$PROJECT_DIR" ensure || {
  echo "Failed to provision keys" >&2
  exit 1
}

# Verify keys work
envseal --project "$PROJECT_DIR" verify

# Run tests with injected secrets
envseal --project "$PROJECT_DIR" run -- npm test
```

---

## Testing

The CLI is tested with a shell-only end-to-end test (`test/shell-e2e.test.ts`) that:

1. Spawns the real compiled `dist/bin.js` as a child process.
2. Drives the complete flow: `init` → `status` → `set` → `status` → `doctor`.
3. Uses the stub prompter (gated by `ENVSEAL_TEST_MODE=1` and `ENVSEAL_TEST_PROMPTER_VALUE`).
4. **Asserts the sentinel value never appears in any stdout/stderr**, proving the flow is leak-free.

This is the Tier-4 integration gate: proof that an agent with only shell command access can safely provision secrets without ever seeing them.


## `run` confirmation

`envseal run` injects secrets into a child process, so it asks for confirmation first.

| Situation | Behaviour |
|---|---|
| Interactive terminal | Prompts `Continue? [y/N]`, showing the command, the keys, and a warning when the command can make network requests |
| No terminal, no `--yes` | Exits `4` (`SEP_NO_INTERACTIVE_SURFACE`) explaining that confirmation is impossible here — it does **not** report a refusal the user never made |
| `--yes` or `ENVSEAL_ASSUME_YES=1` | Proceeds without prompting. Intended for CI and shell-only agents that have already established trust in the command |

Child `stdout`/`stderr` are passed through the redactor either way, so an injected value cannot appear in what the caller reads back.
