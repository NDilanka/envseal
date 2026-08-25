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
| T2 | Model shells out: `cat .env`, `source .env`, `env -i cat .env`, `echo $KEY`, `printenv`, `env`, `grep -r sk-` | Claude Code's companion `PreToolUse` hook denies file reads matching `.env*`, `*.pem`, `*.key` patterns and denies Bash commands that would expose secret paths or dump environment variables. Command matching is heuristic: it splits pipelines, unwraps wrappers (`sudo`, `env`, `busybox`, …), strips `env` flags before classifying the inner command (`env -i cat .env` is treated as `cat .env`), treats `source` and `.` as file readers on secret paths, and recurses into nested `sh -c` payloads up to `MAX_PAYLOAD_DEPTH` (3) — deeper nesting is denied. File tools that read `env.schema.jsonc` are denied when the on-disk file contains high-confidence secret-shaped text (see T3). On internal hook errors the default is **fail-open** (the tool call proceeds); set `ENVSEAL_HOOK_FAIL_CLOSED=1` to invert that. **Cursor, Aider, and Continue have no PreToolUse hook** — they are Tier B/C (protocol plus advisory rules only); a shell command can still read `.env`. **Code:** `plugins/claude-code/hooks/pre-tool-use.ts`. Denial messages are instructive, telling the model which tool to use instead. |
| T3 | Model puts a value in its own request (hallucinated or copied from elsewhere) | Request schemas use `.strict()` from zod, which rejects any unexpected fields including a `value` field. `ManifestEntry` schema in `packages/protocol/src/schemas.ts` declares `.strict()` and includes a `superRefine` check. Any request whose free-text fields match the secret-shaped detector is rejected. `loadManifest()` scans the **raw JSONC text** (comments included) before parsing; secret-shaped content in the manifest file throws `SEP_VALUE_IN_DECLARATION` and nothing is loaded. The PreToolUse hook additionally denies a `Read` of `env.schema.jsonc` when high-confidence secret-shaped text is present on disk — closing the gap where a hand-edited manifest could be read into the transcript even though the broker would refuse to load it. **Code:** `packages/core/src/manifest.ts` (`loadManifest`), `packages/core/src/guard.ts`, `packages/core/src/broker.ts`; `plugins/claude-code/hooks/pre-tool-use.ts` (`envSchemaJsoncHasHighConfidenceSecret`). |
| T4 | User pastes the key into chat despite the flow existing | `UserPromptSubmit` hook detects secret-shaped strings before they reach the model (known provider prefixes, registry `format.pattern` values when bounded, high-entropy tokens, connection strings with credentials). The detector no longer drops high-entropy JSON/JS values solely because they sit next to `{`, `:`, or `}` — `qualifiesAsGenericHighEntropy()` overrides the code-adjacent exclusion for credential-shaped blobs. Unprefixed keys without a vendor prefix may still surface only as **medium**-confidence generic hits, not high-confidence; recall is improved but not complete for every unprefixed shape. On detection: redacts before the model sees it, tells the user in the terminal what was detected (without revealing the value), confirms it was not sent to the model, warns to rotate if it was ever pasted in a previous chat, and offers to route it through the broker. **Code:** `plugins/claude-code/hooks/user-prompt-submit.ts`; `packages/detector/src/index.ts` and `packages/detector/src/exclusions.ts`. |
| T5 | Secret leaks via subprocess output during a test run | `env_use` injects secrets into the child environment only (not the parent), and pipes child stdout/stderr through an exact-match + encoding-variant redaction filter built from the live values. The redaction includes the exact string, base64 encodings, URL-encoding, JSON-string escaping, and any ≥20-char prefix of the value. `env_use` refuses with `SEP_NOT_DECLARED` or `SEP_KEYS_MISSING` when a requested key is not declared or has no stored value — there is no partial injection of whichever keys happen to be present. **Code:** `packages/core/src/exec.ts` spawns with `env: {...}` and passes output through `redact()` from `packages/core/src/redact.ts`; `packages/core/src/broker.ts` (`use()`). |
| T6 | Secret leaks via process listing / crash dump when injected | Injection via `env_use` is opt-in per invocation, scoped to one child process, never exported to the broker's own `process.env`. Env-dumping commands are blocked (T2). On Linux, `/proc/<pid>/environ` of an `env_use` child is readable by other same-uid processes — documented as a residual risk. **Code:** `packages/core/src/exec.ts` passes env only to the child spawn call, never to the broker's process. |
| T7 | `.env` gets committed to git | Before writing, the broker checks that `.env` is not git-tracked and that `.gitignore` covers it; if either check fails it refuses with `SEP_GITIGNORE_UNSAFE` and writes nothing. **Outside a git work tree**, the same `.gitignore` requirement applies — there is no silent bypass when the project is not under git. After an atomic replace on POSIX, the broker sets mode `0600` on `.env`. The refusal is unconditional — there is no offer-to-add-to-gitignore prompt and no override flag wired up today. **Code:** `packages/core/src/sinks/dotenv.ts` (`assertGitSafe`, `atomicWrite`) performs the checks before any write. |
| T8 | Malicious manifest exfiltrates the key via its "validation probe" | Probe hosts must be on the provider-registry allowlist, or the exact host is displayed in the approval UI and requires explicit first-use consent, recorded per-project in `.envseal/approvals.json`. Any change to the probe (URL, headers, method) re-triggers consent. Registry allowlist is built from `packages/registry/providers/*.json`. **Code:** `packages/core/src/verify.ts` checks hosts against allowlist and enforces approval flow; `packages/core/src/approvals.ts` tracks consent per project. |
| T9 | Local phishing: another process opens a lookalike input page | Ticket nonce is displayed in the terminal/agent UI *and* rendered prominently in the page header. The user matches them to confirm they are talking to the legitimate prompter. Loopback server is single-use (closes after first successful submission), bound to 127.0.0.1 only (IPv4 loopback, not 0.0.0.0 or ::1), port 0 (ephemeral), with strict Host/Origin validation. **Code:** `packages/prompters/src/loopback.ts` implements all mechanics: single-use per ticket, nonce display, Host validation, server closure. |
| T10 | DNS rebinding against the loopback server | HTTP requests must have `Host` header exactly `127.0.0.1:<port>`. If an `Origin` header is present, it MUST equal `http://127.0.0.1:<port>` or be the string `null`; any other value is rejected with 400. (Browsers send Origin on every POST, including same-origin ones; because this page sets `Referrer-Policy: no-referrer`, the browser serializes that origin as null. Origin is defence-in-depth here — the primary controls are the 128-bit path nonce and the ticket-bound CSRF token, neither readable cross-origin.) **Code:** `packages/prompters/src/loopback.ts` validates `Host` and `Origin`. |
| T11 | Prompt injection in repo content drives `env_request` + exfiltration | The prompter popup always shows the project path, the model's verbatim `reason` string, and the target sink. `env_use` requires user confirmation for every command and displays the full command; commands with detected network egress add an explicit warning on top. `env_revoke` likewise requires user confirmation on MCP, SDK, HTTP, and CLI bindings before any sink removal. Since 0.1.3, consent binds to **content**, not just displayed text: every argument naming a readable file is SHA-256 fingerprinted before the dialog is drawn (the dialog shows path + hash), and every fingerprint is re-verified against fresh disk content immediately before spawn — any mismatch refuses with `SEP_TARGET_CHANGED` and nothing executes, closing the window where injected repo content mutates a script after the user read the dialog. Residual risks remain: a user who reads the confirmation dialog and clicks through still defeats the control (inherent to any system where an agent can execute code); arguments that do not name readable files (PATH-resolved executables) stay name-approved; and the re-check narrows but cannot fully close the check-to-use race without handing an fd to the OS loader. **Code:** `packages/core/src/broker.ts` passes reason verbatim and wires `onRevokeConfirm`; `packages/core/src/exec.ts` detects egress (curl, wget, nc, ssh, HTTP tools), snapshots file fingerprints (`snapshotNamedFiles`) at approval and pre-spawn (`assertUnchanged`), and prompts; dialogs render the fingerprints (`useConfirmationBody`, `revokeConfirmationBody` in MCP/SDK confirm twins). See residual risks. |
| T12 | Broker writes the value into its own log | Structured logger with a hard allowlist of loggable fields. Values are never passed to the logger. `SecretValue` is a branded `Buffer` — it has a `toString()`, so the type system alone cannot stop a conversion — and the active guard is a custom eslint rule (`envseal/no-secret-to-log`) that fails on any call passing a `SecretValue`-typed expression to `console.*` or the logger. **Code:** `packages/core/src/audit.ts` defines audit events with a type-safe field allowlist; the rule lives in `tools/eslint-rules/no-secret-to-log.js` and is enabled in `eslint.config.js` (flat config; there is no `.eslintrc`). |
| T13 | Value persists in memory / swap | Values are held in `Buffer`, zeroed immediately after use. Node.js string immutability means once a value becomes a JS `string` it cannot be reliably zeroed — this is a documented limitation. Mitigation: keep the set of conversion points small and named. Values ARE converted to `string` outside the sink writer, at three deliberate points: child-env injection (`packages/core/src/exec.ts`), redaction-variant construction (`packages/core/src/redact.ts`), and probe-header substitution (`packages/core/src/verify.ts`); the sink writers convert at the point of write via the explicitly named `unsafeSecretToUtf8` with eslint suppression. |
| T14 | Man-in-the-middle on the verification probe | The verify probe MUST use HTTPS with default certificate validation. No `NODE_TLS_REJECT_UNAUTHORIZED=0` escape hatch is available — the broker does not read that env var. **Code:** `packages/core/src/verify.ts` performs HTTPS validation and fails probes on cert errors. The broker never enters a mode that disables TLS. |

## Design principles that enable this

1. **The model manipulates declarations, never values.** This is the load-bearing principle. If the model's only verbs are "declare that this project needs X" and "ensure X exists", then no sequence of model actions can produce a value in the transcript. Safety is structural.

2. **One protocol, many input surfaces.** Terminal, browser, native dialog, IDE box — all are prompter adapters behind one interface. The protocol does not care which is used.

3. **Refuse rather than degrade.** No interactive surface available? Fail with `SEP_NO_INTERACTIVE_SURFACE`. Never fall back to asking in chat.

4. **Redacted-by-construction outputs.** Every string that leaves the broker toward the model passes through one function: `redact()` in `packages/core/src/redact.ts`. There is exactly one exit point and it is filtered.

5. **The user sees what the agent asked for, verbatim.** No summarizing the model's `reason` field. Prompt injection is best countered by showing the user the actual request text.

6. **Provisioning is idempotent and declarative.** `env_ensure` on an already-satisfied manifest is a no-op. Re-running is always safe.

7. **Zero required network access.** The broker works fully offline; verification probes are optional and opt-in.
