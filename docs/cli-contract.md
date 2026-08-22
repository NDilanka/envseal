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

*UNSATISFIED is retriable in the sense that running `ensure` again may succeed if the user provides the keys.

## Commands

### `envseal init [--host <name>]`

Initialize `env.schema.jsonc` at the project root.

**Flags:**
- `--host <name>` — Override host detection (e.g., `cursor`, `aider`). Without this, auto-detects.
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

### `envseal ensure`

Prompt for every missing required key in one pass.

**Flags:**
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

**Exit codes:**
- 0 — All required keys are present.
- 1 — One or more required keys are still missing after the operation.
- 3 — User cancelled.
- 4 — No interactive surface available.

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

Audit the project configuration. Reports: project root, manifest path, detected host + tier + recommendation, gitignore coverage, file permissions, count of missing required keys.

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
Missing required keys: 1
  - OPENAI_API_KEY
```

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

**Exit codes:**
- (server exits only on error or signal)

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
