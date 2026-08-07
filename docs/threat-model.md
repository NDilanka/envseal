# Threat Model

This document details envseal's threat model: the principals involved, their trust levels, and the comprehensive set of threats and mitigations.

## Principals and trust

Four principals interact in the envseal system:

**User** (Authority over secret values)
- Sole source of the secret value
- Sole approver of each write to a sink
- Supplies input through the secure prompter interface

**Broker** (Trusted)
- Local process running under the user's uid
- Owns the input UI, the value in memory, and the write to sinks
- Responsible for ensuring the secret's path never crosses an untrusted boundary

**Harness** (Claude Code, Cursor, Zed, Continue, Cline, etc.) (Semi-trusted transport)
- Trusted to execute code in the user's development environment
- NOT trusted with secret values
- Routes tool calls and renders/persists transcripts to servers
- Its job is literally to write everything it sees to a transcript and mail it to a model provider
- Therefore the secret value must never cross the harness ↔ model channel

**Model** (Untrusted for values)
- Emits tool-call requests and reads redacted metadata
- MUST NOT see secret values, ever
- Receives only: key names, declarations, tickets, and redacted status

The unusual principle here is the harness: it is trusted to execute code but *not* trusted with secret values, precisely because its job is to persist and transmit everything it sees. The secret's path is therefore:

```
User → [secure input surface] → Broker → [sink: .env / keychain / vault]
```

and it crosses no other boundary.

## Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | Model asks broker to read back a stored value | Broker exposes no read-value operation. `env_describe` returns metadata only: presence, length bucket (never exact length), format-valid boolean, and HMAC fingerprint. No flag or debug mode returns values. **Code:** `packages/core/src/broker.ts` implements `describe()` with KeyStatus schema, where `packages/protocol/src/schemas.ts` defines KeyStatus without any value field. |
| T2 | Model shells out: `cat .env`, `echo $KEY`, `printenv`, `env`, `grep -r sk-` | Companion `PreToolUse` hook denies file reads matching `.env*`, `*.pem`, `*.key` patterns and denies commands matching env-dumping patterns (printenv, bare env, export -p, cat/head/tail/less on secret paths, echo $VAR, grep -r with secret pattern). **Code:** `plugins/claude-code/hooks/pre-tool-use.ts` contains the deny rules. Denial messages are instructive, telling the model which tool to use instead. |
| T3 | Model puts a value in its own request (hallucinated or copied from elsewhere) | Request schemas use `.strict()` from zod, which rejects any unexpected fields including a `value` field. `ManifestEntry` schema in `packages/protocol/src/schemas.ts` declares `.strict()` and includes a `superRefine` check. Any request whose free-text fields match the secret-shaped detector is rejected. **Code:** `packages/core/src/broker.ts` validates input through protocol schemas; `packages/detector/src/index.ts` detects secret-shaped strings. |
| T4 | User pastes the key into chat despite the flow existing | `UserPromptSubmit` hook detects secret-shaped strings before they reach the model (known provider prefixes, high-entropy tokens, connection strings with credentials). On detection: redacts before the model sees it, tells the user in the terminal what was detected (without revealing the value), confirms it was not sent to the model, warns to rotate if it was ever pasted in a previous chat, and offers to route it through the broker. **Code:** `plugins/claude-code/hooks/user-prompt-submit.ts` contains detection and redaction; `packages/detector/src/index.ts` provides the detection engine. |
| T5 | Secret leaks via subprocess output during a test run | `env_use` injects secrets into the child environment only (not the parent), and pipes child stdout/stderr through an exact-match + encoding-variant redaction filter built from the live values. The redaction includes the exact string, base64 encodings, URL-encoding, JSON-string escaping, and any ≥20-char prefix of the value. **Code:** `packages/core/src/exec.ts` spawns with `env: {...}` and passes output through `redact()` from `packages/core/src/redact.ts`. |
| T6 | Secret leaks via process listing / crash dump when injected | Injection via `env_use` is opt-in per invocation, scoped to one child process, never exported to the broker's own `process.env`. Env-dumping commands are blocked (T2). On Linux, `/proc/<pid>/environ` of an `env_use` child is readable by other same-uid processes — documented as a residual risk. **Code:** `packages/core/src/exec.ts` passes env only to the child spawn call, never to the broker's process. |
| T7 | `.env` gets committed to git | Before writing, the broker asserts `.gitignore` coverage via `git ls-files --error-unmatch .env`. On failure, throws `SEP_GITIGNORE_UNSAFE`, offers to add `.env` to `.gitignore`, and refuses to write without explicit override. An optional pre-commit guard is available. **Code:** `packages/core/src/sinks/dotenv.ts` performs gitignore checks before any write. |
| T8 | Malicious manifest exfiltrates the key via its "validation probe" | Probe hosts must be on the provider-registry allowlist, or the exact host is displayed in the approval UI and requires explicit first-use consent, recorded per-project in `.envseal/approvals.json`. Any change to the probe (URL, headers, method) re-triggers consent. Registry allowlist is built from `packages/registry/providers/*.json`. **Code:** `packages/core/src/verify.ts` checks hosts against allowlist and enforces approval flow; `packages/core/src/approvals.ts` tracks consent per project. |
| T9 | Local phishing: another process opens a lookalike input page | Ticket nonce is displayed in the terminal/agent UI *and* rendered prominently in the page header. The user matches them to confirm they are talking to the legitimate prompter. Loopback server is single-use (closes after first successful submission), bound to 127.0.0.1 only (IPv4 loopback, not 0.0.0.0 or ::1), port 0 (ephemeral), with strict Host/Origin validation. **Code:** `packages/prompters/src/loopback.ts` implements all mechanics: single-use per ticket, nonce display, Host validation, server closure. |
| T10 | DNS rebinding against the loopback server | HTTP requests must have `Host` header exactly `127.0.0.1:<port>`. Presence of an `Origin` header is rejected (browsers only send Origin cross-origin, so its presence indicates the request did not originate from the page served). **Code:** `packages/prompters/src/loopback.ts` validates `Host` and rejects requests with `Origin`. |
| T11 | Prompt injection in repo content drives `env_request` + exfiltration | The prompter popup always shows the project path, the model's verbatim `reason` string, and the target sink. `env_use` requires user confirmation for commands with network egress, and displays the full command. Residual risk remains: a user who reads the confirmation dialog and clicks through defeats the control. This is inherent to any system where an agent can execute code. **Code:** `packages/core/src/broker.ts` passes reason verbatim; `packages/core/src/exec.ts` detects egress (curl, wget, nc, ssh, HTTP tools) and prompts. See residual risks. |
| T12 | Broker writes the value into its own log | Structured logger with a hard allowlist of loggable fields. Values are never passed to the logger; the type system enforces this (`SecretValue` is a branded type with no `toString`). A custom eslint rule (`no-secret-to-log`) fails on any call passing a `SecretValue`-typed expression to `console.*` or the logger. **Code:** `packages/core/src/audit.ts` defines audit events with type-safe field allowlist; custom eslint rule in `.eslintrc` blocks secret logging. |
| T13 | Value persists in memory / swap | Values are held in `Buffer`, zeroed immediately after the sink write completes. Node.js string immutability means once a value becomes a JS `string` it cannot be reliably zeroed — this is a documented limitation. Mitigation: never convert to `string` outside the sink writer, which is the only place values are serialized. **Code:** `packages/core/src/sinks/dotenv.ts` and other sink writers accept `SecretValue` (Buffer-based) and convert only at the point of write using an explicitly named `unsafeToUtf8` with eslint suppression. |
| T14 | Man-in-the-middle on the verification probe | The verify probe MUST use HTTPS with default certificate validation. No `NODE_TLS_REJECT_UNAUTHORIZED=0` escape hatch is available — the broker does not read that env var. **Code:** `packages/core/src/verify.ts` performs HTTPS validation and fails probes on cert errors. The broker never enters a mode that disables TLS. |

## Design principles that enable this

1. **The model manipulates declarations, never values.** This is the load-bearing principle. If the model's only verbs are "declare that this project needs X" and "ensure X exists", then no sequence of model actions can produce a value in the transcript. Safety is structural.

2. **One protocol, many input surfaces.** Terminal, browser, native dialog, IDE box — all are prompter adapters behind one interface. The protocol does not care which is used.

3. **Refuse rather than degrade.** No interactive surface available? Fail with `SEP_NO_INTERACTIVE_SURFACE`. Never fall back to asking in chat.

4. **Redacted-by-construction outputs.** Every string that leaves the broker toward the model passes through one function: `redact()` in `packages/core/src/redact.ts`. There is exactly one exit point and it is filtered.

5. **The user sees what the agent asked for, verbatim.** No summarizing the model's `reason` field. Prompt injection is best countered by showing the user the actual request text.

6. **Provisioning is idempotent and declarative.** `env_ensure` on an already-satisfied manifest is a no-op. Re-running is always safe.

7. **Zero required network access.** The broker works fully offline; verification probes are optional and opt-in.
