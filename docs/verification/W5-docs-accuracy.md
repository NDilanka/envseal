# W5 — Docs-to-implementation accuracy sweep

Method: line-by-line sweep of the six user-facing documents against the source tree
(`packages/cli|protocol|core|mcp-server|http-server|sdk|prompters|registry|detector`,
`plugins/claude-code/hooks`, `extensions/vscode`). No source file was modified; this
report is the only file written.

Result codes: `OK` / `MISMATCH` / `MISSING` / `UNVERIFIABLE` (defined in the task).

## Claim-by-claim table

| Doc | Line | Claim | Kind | Verified against | Result |
|---|---|---|---|---|---|
| README.md | 5 | value is written to `.env` or a keychain | Sinks | `packages/core/src/sinks/registry.ts`, `keychain.ts` | OK |
| README.md | 32 | harness `spawns (stdio) / connects (http+sse)` | Tool/transport | `packages/mcp-server/src/bin.ts` (only `StdioServerTransport`; `--http`/`--port` parsed but unused); no SSE/streamable-HTTP code anywhere | MISMATCH — only stdio is implemented; no http/SSE/streamable-HTTP transport exists |
| README.md | 40–43 | broker "Sink registry: dotenv · keychain · sops / 1password · doppler · vault" (diagram implies functional sinks) | Sinks | `packages/core/src/sinks/registry.ts` — `sops`, `onepassword`, `doppler`, `vault`, `external` are `UnimplementedSink` that throw `SEP_SINK_UNAVAILABLE` | MISMATCH — only `dotenv` (real) and `keychain` (write-only, `read()`→null, `remove()`→false) are implemented |
| README.md | 49 | prompter adapter 1: `loopback-browser` (default, cross-platform) | Tools | `packages/prompters/src/registry.ts` (`selectPrompter` defaults to loopback) | OK |
| README.md | 49 | prompter adapter 2: `native-dialog` (osascript/WinForms/zenity) | Tools | `packages/prompters/src/native.ts` — macOS `osascript`, Linux `zenity/kdialog/ssh-askpass`, **Windows = PowerShell `Read-Host -AsSecureString`** | MISMATCH — Windows native dialog is PowerShell, not WinForms |
| README.md | 50 | prompter adapter 3: `ide` (VS Code showInputBox) | Tools | `extensions/vscode/src/extension.ts` (`showInputBox({password:true})` over a token-auth socket), `packages/prompters/src/ide.ts` | OK |
| README.md | 51 | prompter adapter 4: `tty` (direct /dev/tty, CONIN$) | Tools | `packages/prompters/src/tty.ts` (`POSIX_DEVICE='/dev/tty'`, `WIN_IN='CONIN$'`) | OK |
| README.md | 52 | prompter adapter 5: `none` (CI → hard fail) | Tools | `packages/prompters/src/none.ts` throws `SEP_NO_INTERACTIVE_SURFACE`; `registry.ts` returns `none` on `CI` | OK |
| README.md | 60 | secret travels `User → surface → broker → sink (.env / keychain / vault)` | Sinks | `packages/core/src/sinks/registry.ts` — `vault` sink is an `UnimplementedSink` throwing `SEP_SINK_UNAVAILABLE` | MISMATCH — vault is not a working sink; only `.env` and `keychain` accept values |
| README.md | 77 | `pnpm install && pnpm build` | Shell command | root `package.json` scripts `build: pnpm -r build` | OK |
| README.md | 80–81 | `node /path/to/envseal/packages/cli/dist/bin.js init` / `ensure` | Shell command | `packages/cli/dist/bin.js` exists; `init`/`ensure` subcommands in `packages/cli/src/bin.ts` | OK |
| README.md | 84 | once published: `pnpm add -D @envseal/cli` and `npx envseal init` | Shell command | `packages/cli/package.json` — name `@envseal/cli`, bin `envseal -> ./dist/bin.js` | OK (future-publish statement; consistent with package metadata) |
| README.md | 86 | `init` scans source for env-var references, writes `env.schema.jsonc`, fills provider metadata for recognised keys | Shell/prose | `packages/cli/src/commands/init.ts`, `scan.ts`; provider defaults via `packages/core/src/broker.ts:declare()` → `@envseal/registry.findKey` | OK |
| README.md | 86 | `ensure` prompts for everything missing in one pass | Shell/prose | `packages/cli/src/commands/ensure.ts` (single `request` + `await`) | OK |
| README.md | 86 | values go to `.env` by default after checking `.gitignore` covers it and git is not already tracking it | Sinks | `packages/core/src/sinks/dotenv.ts:assertGitSafe` (tracked via `git ls-files --error-unmatch`, ignored via `git check-ignore`) | OK |
| README.md | 86 | or OS keychain with `sink: "keychain"` | Sinks | `packages/core/src/sinks/keychain.ts` (macOS `security`, Linux `secret-tool`, Windows DPAPI file, not the OS keychain) | OK (see finding: keychain is write-only) |
| README.md | 94 | Tier 1 MCP transport `stdio + streamable HTTP` | Sinks/transport | `packages/mcp-server/src/bin.ts` — only stdio transport; `--http` accepted but ignored | MISMATCH — streamable-HTTP transport is not implemented |
| README.md | 103 | `envseal doctor` reports which tier you have | Shell/prose | `packages/cli/src/commands/doctor.ts`, `host.ts` | OK |
| README.md | 105–107 | protection tiers A/B/C | Prose | `packages/cli/src/host.ts` (A: Claude Code, B: Cursor/Continue/generic, C: aider/unknown) | OK |
| README.md | 109 | broker "requires confirmation for suspicious commands"; network egress warnings | Prose | `packages/core/src/exec.ts` — confirmation is required for **every** `env_use`, network warning shown only when egress detected | MISMATCH — confirmation is unconditional, not limited to "suspicious"/network commands |
| README.md | 113 | "The seven tools" listed | Tools | `packages/protocol/src/index.ts:SEP_TOOL_NAMES` (exact 7) | OK |
| README.md | 116 | `env_describe` read-only, never returns values, no flag/debug mode does | Prose | `packages/mcp-server/src/tools/describe.ts`, `packages/core/src/broker.ts:describe()` | OK |
| README.md | 117 | `env_declare` input "strictly rejected if it contains a value-shaped field" | Schemas | `EnvirDeclareInput`/`ManifestEntry` `.strict()`; `declareEntries` maps `unrecognized_keys` → `SEP_VALUE_IN_REQUEST` (`packages/core/src/manifest.ts`) | OK (literal `value` field rejected; arbitrary secret-shaped content not — see T3 row) |
| README.md | 118 | `env_await` blocks up to 90 s | Numeric | `EnvAwaitInput.timeoutMs` default 90000 (`packages/protocol/src/schemas.ts`); CLI passes 90000 | OK |
| README.md | 118 | `env_await` returns per-key outcome "(stored, cancelled, invalid_format, verify_failed, timeout)" | Schemas | `TicketKeyOutcome` enum = stored, skipped, cancelled, invalid_format, verify_failed, timeout | MISMATCH — omits the `skipped` outcome the protocol actually returns |
| README.md | 119 | `env_verify` returns classified result without showing upstream response bodies | Prose | `packages/core/src/verify.ts` (classifies, `redact()`s error message) | OK |
| README.md | 120 | `env_use` "Requires confirmation for network commands" | Prose | `packages/core/src/exec.ts` — confirmation required for all commands; egress only adds a warning | MISMATCH — confirmation is not conditional on network usage |
| README.md | 121 | `env_revoke(key)` removes from sink and reports rotation URL | Prose | `packages/core/src/broker.ts:revoke()`, `packages/cli/src/commands/revoke.ts` | OK (no user confirmation in code — see SPEC revoke row) |
| README.md | 125 | a test spawns the real MCP server child, drives full provisioning over stdio, records both directions incl stderr, asserts sentinel nowhere while flow completed | Prose | `packages/mcp-server/test/zero-leak.test.ts` | OK |
| SECURITY.md | 7–8 | supported-versions policy (0.x dev, 1.0+ full) | Prose | policy statement | OK |
| SECURITY.md | 14–15 | email `security@envseal.dev`; advisories URL `github.com/envseal/envseal/security/advisories` | Prose | no in-repo evidence to confirm the domain/endpoint | UNVERIFIABLE — external address, cannot be validated from the tree |
| SECURITY.md | 27–33 | in-scope: SEP/1 spec+impl, `packages/core` broker, prompter adapters, hooks (PreToolUse/UserPromptSubmit/SessionStart), redactor, MCP/HTTP/SDK/CLI bindings | File paths | `spec/sep-1/`, `packages/core/src/` exists, `packages/prompters/src/`, `plugins/claude-code/hooks/{pre-tool-use,user-prompt-submit,session-start}.ts`, `packages/{mcp-server,http-server,sdk,cli}/src/` | OK |
| SECURITY.md | 48 | threat model "T1–T14" | Numeric | `docs/threat-model.md` has 14 threat rows T1–T14 | OK |
| SECURITY.md | 50 | "five risks that remain" | Numeric | `docs/residual-risks.md` has exactly 5 risk sections | OK |
| docs/threat-model.md | 43 | T1 — no read-value operation; `describe()` returns metadata only; KeyStatus has no value field | Schemas | `packages/core/src/broker.ts:describe()`, `packages/protocol/src/schemas.ts:KeyStatus` | OK |
| docs/threat-model.md | 44 | T2 — pre-tool-use denies `.env*`, `*.pem`, `*.key`, printenv, bare env, `export -p`, cat/head/tail/less on secret paths, `echo $VAR`, `grep -r` with secret pattern | Tools/paths | `plugins/claude-code/hooks/pre-tool-use.ts` (isDeniedSecretPath, decideBash) | OK |
| docs/threat-model.md | 45 | T3 — request schemas `.strict()` reject unknown fields incl a `value` field | Schemas | `ManifestEntry`/`EnvDeclareInput` `.strict()` | OK |
| docs/threat-model.md | 45 | T3 — "Any request whose free-text fields match the secret-shaped detector is rejected" | Prose | no detector invocation in the declare path; `broker.declare`/`manifest.declareEntries` only run zod `.strict()` | MISMATCH — only a literal `value`/unknown field is rejected; arbitrary secret-shaped content passes |
| docs/threat-model.md | 46 | T4 — UserPromptSubmit detects provider prefixes/high-entropy/connection strings, redacts, notifies, warns to rotate, offers broker route | Tools/paths | `plugins/claude-code/hooks/user-prompt-submit.ts`, `packages/detector/src/index.ts` | OK |
| docs/threat-model.md | 47 | T5 — `env_use` injects to child env only; redacts exact string, base64, URL-encoding, JSON-escape, ≥20-char prefixes | Prose | `packages/core/src/exec.ts` (`env: childEnv`, `shell:false`), `packages/core/src/redact.ts` (variants, `PREFIX_MIN_LENGTH=20`) | OK |
| docs/threat-model.md | 48 | T6 — injection scoped to one child, never exported to broker's `process.env` | Prose | `packages/core/src/exec.ts` builds a fresh `childEnv` | OK |
| docs/threat-model.md | 49 | T7 — asserts gitignore via `git ls-files --error-unmatch .env`, throws `SEP_GITIGNORE_UNSAFE`, offers to add `.env` to gitignore, refuses without explicit override | Sinks/prose | `packages/core/src/sinks/dotenv.ts:assertGitSafe` throws `SEP_GITIGNORE_UNSAFE`; no user-facing "offer to add" or override flow exists in CLI/MCP; `allowUnsafe` option is never wired to any binding | MISMATCH — the offer-and-override UX is not implemented; only the hard refusal is |
| docs/threat-model.md | 50 | T8 — probe allowlist + `.envseal/approvals.json` consent, re-consent on change | Prose/paths | `packages/core/src/approvals.ts`, `verify.ts`, `packages/registry/src/index.ts:allProbeHosts` | OK (mechanism exists; see probe-approval-UI finding) |
| docs/threat-model.md | 51 | T9 — nonce in terminal + page header, single-use loopback on 127.0.0.1:0, Host/Origin validation | Prose | `packages/prompters/src/loopback.ts`, `packages/core/src/broker.ts:request` | OK |
| docs/threat-model.md | 52 | T10 — Host must be `127.0.0.1:<port>`; any `Origin` header rejected | Prose | `packages/prompters/src/loopback.ts:serveRequest` | OK |
| docs/threat-model.md | 53 | T11 — reason passed verbatim; egress (curl, wget, nc, ssh, HTTP tools) detected and prompts | Prose | `packages/core/src/broker.ts:request` (reason verbatim), `packages/core/src/exec.ts:detectNetworkEgress` | OK |
| docs/threat-model.md | 54 | T12 — audit allowlist; `SecretValue` is "a branded type with no toString"; custom eslint rule in `.eslintrc` blocks secret logging | Prose | `packages/core/src/audit.ts`; `tools/eslint-rules/no-secret-to-log.js` wired in **`eslint.config.js`** (not `.eslintrc`); `SecretValue` is `Buffer`-based and **does** have `toString()` | MISMATCH — rule lives in `eslint.config.js` (`.eslintrc` does not exist) and `SecretValue` is a Buffer with `toString`, so the "no toString" claim is false (the real guard is the lint rule) |
| docs/threat-model.md | 55 | T13 — values held in Buffer, zeroed after write; "never convert to string outside the sink writer"; `unsafeToUtf8` with eslint suppression | Prose | `zero()` called in `broker.ts`; but `unsafeSecretToUtf8` is used in `exec.ts` (child env), `redact.ts` (variants) and `verify.ts` (headers), and has no eslint suppression | MISMATCH — values are converted to string outside the sink writer (child env injection, redaction, probe headers); the "only the sink writer" claim is false |
| docs/threat-model.md | 56 | T14 — verify MUST use HTTPS, default cert validation, no `NODE_TLS_REJECT_UNAUTHORIZED=0` escape hatch | Prose | `packages/core/src/verify.ts` rejects non-`https://` and never reads `NODE_TLS_REJECT_UNAUTHORIZED` (string absent from all source) | OK |
| docs/threat-model.md | 64 | no surface → fail with `SEP_NO_INTERACTIVE_SURFACE` | Errors | `packages/protocol/src/errors.ts`, `packages/prompters/src/none.ts` | OK |
| docs/threat-model.md | 66 | every outbound string passes through one `redact()` egress point | Prose | `packages/mcp-server/src/respond.ts` (single egress, redacts); SDK/HTTP bindings return schema objects without values | OK (substantively true at the MCP boundary) |
| docs/residual-risks.md | 9 | curl exfiltration example handled by egress detect → confirm dialog | Prose | `packages/core/src/exec.ts` | OK |
| docs/residual-risks.md | 28–30 | mitigation: "Recommend `keychain` or vault sinks so `.env` holds only references" | Sinks | vault sink is a stub (`SEP_SINK_UNAVAILABLE`); keychain `read()` returns null (write-only) and no reference/indirection is stored in `.env` | MISMATCH — vault is not usable and keychain holds no `.env` reference |
| docs/residual-risks.md | 38–39 | values held as Buffer end-to-end, "converted to `string` only at the point where they are written to a sink" | Prose | `unsafeSecretToUtf8` also used in `exec.ts`, `redact.ts`, `verify.ts` | MISMATCH — string conversion also happens for env injection, redaction and probe headers |
| docs/residual-risks.md | 49 | "envseal zeroes Buffers immediately after use" | Prose | `zero()` in `broker.ts` after write/use/verify | OK |
| docs/residual-risks.md | 50 | mitigation "prefer sinks that keep values out of plaintext (keychain, vault, SOPS)" | Sinks | `vault` and `sops` are unimplemented stubs | MISMATCH — only keychain is a working non-plaintext sink |
| docs/residual-risks.md | 59 | example `envseal run -- npm test` | Shell | `packages/cli/src/bin.ts` (`run --` required) | OK |
| docs/residual-risks.md | 65–68 | broker does not export to `process.env`, injects only into child, blocks env-dumping | Prose | `packages/core/src/exec.ts`, `plugins/claude-code/hooks/pre-tool-use.ts` | OK |
| docs/residual-risks.md | 116 | loopback prompter "opens an HTTPS page at 127.0.0.1:<port>" | Prose | `packages/prompters/src/loopback.ts` serves plain **HTTP** (`http://127.0.0.1:...`) | MISMATCH — the page is HTTP, not HTTPS |
| docs/residual-risks.md | 122 | CSP is exactly `default-src 'none'; form-action 'self'` | Prose | `securityHeaders()` sets `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'; form-action 'self'; base-uri 'none'` | MISMATCH — the quoted CSP is a subset; actual policy adds style/script nonces and `base-uri 'none'` (claim remains protective) |
| docs/residual-risks.md | 123 | single-use server closes after first submission; no external resources; password field + reveal toggle; `Cache-Control: no-store`; `X-Frame-Options: DENY` | Prose | `packages/prompters/src/loopback.ts` | OK |
| docs/residual-risks.md | 131 | "Does not use a TLS certificate pinning" | Prose | loopback is plain HTTP; no TLS/pinning | OK |
| docs/residual-risks.md | 156 | best-practice "using keychain/vault sinks to keep secrets out of plaintext" | Sinks | vault is a stub | MISMATCH — vault sink is not implemented |
| docs/cli-contract.md | 9–16 | exit-code table 0–6 (OK/UNSATISFIED/USAGE/CANCELLED/NO_SURFACE/SINK_FAILURE/VERIFY_FAILED) | Exit codes | `packages/cli/src/exit-codes.ts` EXIT constant | OK |
| docs/cli-contract.md | 17 | UNSATISFIED retriable by re-running `ensure` | Prose | `ensure.ts` re-request on next run | OK |
| docs/cli-contract.md | 21 | `envseal init [--host <name>]` | Shell | `packages/cli/src/bin.ts` (`init`, flag `--host`) | OK |
| docs/cli-contract.md | 26–28 | init flags `--host`, `--json`, `--project` | Shell | bin.ts + `cli-utils.parseArgs` | OK |
| docs/cli-contract.md | 31–38 | init JSON output `{ "initialized": true, "manifestPath", "host", "message" }` | Schemas | `packages/cli/src/commands/init.ts` emits `{ manifestPath, host, protectionTier, scanned, added, updated, unchanged, secretKeys, configKeys, entries }` | MISMATCH — no `initialized` or `message` fields; different shape |
| docs/cli-contract.md | 40 | init always exits 0 on success | Exit codes | `init.ts` returns normally; `fail()` only on error | OK |
| docs/cli-contract.md | 44 | `envseal ensure` prompt for every missing required key in one pass | Shell | `ensure.ts` | OK |
| docs/cli-contract.md | 53–59 | ensure JSON output `{ "satisfied": true, "keysSet": 3, "total": 3 }` | Schemas | `ensure.ts` emits `total` only in the non-empty path; already-satisfied path emits `{ satisfied: true, keysSet: 0 }` with no `total` | MISMATCH — `total` is absent when nothing is missing |
| docs/cli-contract.md | 61–65 | ensure exit codes: 0 present, 1 still missing, 3 user cancelled, 4 no surface | Exit codes | `ensure.ts` exits 1 on any non-satisfied outcome (incl. cancel / no-surface via cancelled ticket); codes 3 and 4 are unreachable (no `SepError` path) | MISMATCH — cancel and no-surface both end in exit 1, not 3/4 |
| docs/cli-contract.md | 69 | `envseal set <KEY>` | Shell | bin.ts (`set` requires KEY) | OK |
| docs/cli-contract.md | 79–83 | set JSON output `{ "key", "outcome" }` | Schemas | `set.ts` | OK |
| docs/cli-contract.md | 85 | `outcome` values: stored, skipped, cancelled, invalid_format, verify_failed, timeout | Schemas | `TicketKeyOutcome` enum identical | OK |
| docs/cli-contract.md | 87–93 | set exit codes 0/1/2/3/4 | Exit codes | `set.ts` exits 0 for every outcome incl. `cancelled`/`invalid_format`/`timeout`; exit 1 only via generic "No outcome returned" (no-surface); codes 3/4 never produced | MISMATCH — "1 — Key not stored" only via an unrelated generic error in CI; cancel/timeout exit 0; 3/4 unreachable |
| docs/cli-contract.md | 96–101 | `envseal status [KEY...]`, repeatable optional args | Shell | bin.ts passes `parsed.args` | OK |
| docs/cli-contract.md | 107–112 | status human output `✓ KEY` / `✗ KEY` | Prose | `status.ts` | OK |
| docs/cli-contract.md | 114–130 | status JSON entries fields (key/present/sink/formatValid/lengthBucket/fingerprint/lastVerified/verifyResult) | Schemas | `status.ts` maps exactly those 8 fields | OK (example value `lengthBucket: "48-64"` matches broker buckets) |
| docs/cli-contract.md | 132–135 | status exit codes 0 (present) / 1 (missing) | Exit codes | `status.ts` (`EXIT.UNSATISFIED` when missingRequired) | OK |
| docs/cli-contract.md | 138–147 | `envseal verify [KEY...]` | Shell | bin.ts | OK |
| docs/cli-contract.md | 156–172 | verify JSON `{ results[{key,result,message}], allOk }` | Schemas | `verify.ts` | OK |
| docs/cli-contract.md | 174–181 | verify result enum (ok/auth_failed/forbidden/rate_limited/network_error/no_probe/probe_not_approved) | Schemas | `VerifyResult` enum identical | OK |
| docs/cli-contract.md | 183–185 | verify exit codes 0 / 6 | Exit codes | `verify.ts` (`EXIT.VERIFY_FAILED=6`) | OK |
| docs/cli-contract.md | 189–198 | `envseal run -- <cmd...>`; `--` required | Shell | bin.ts enforces `--` and non-empty command | OK |
| docs/cli-contract.md | 205–212 | run JSON `{ exitCode, stdout, stderr }` | Schemas | `run.ts` emits `{ exitCode, stdout, stderr, redactedCount }` | MISMATCH — `redactedCount` is present but undocumented |
| docs/cli-contract.md | 214–216 | run exit codes: child passthrough; 2 for no `--` | Exit codes | `bin.ts` (USAGE=2) + `run.ts` (`process.exit(result.exitCode ?? 0)`) | OK |
| docs/cli-contract.md | 220–222 | `envseal doctor` reports root, manifest path, host+tier+recommendation, gitignore coverage, permissions, missing count | Shell/prose | `doctor.ts` | OK |
| docs/cli-contract.md | 239–263 | doctor JSON shape | Schemas | `doctor.ts` output matches field-for-field | OK |
| docs/cli-contract.md | 265–267 | doctor exit codes 0 / 1 | Exit codes | `doctor.ts` | OK |
| docs/cli-contract.md | 271 | `envseal revoke <KEY>` | Shell | bin.ts (`revoke` requires KEY) | OK |
| docs/cli-contract.md | 283–289 | revoke JSON `{ "key", "outcome": "revoked", "rotateUrl" }` | Schemas | `revoke.ts` emits `{ key, removed, rotateUrl }` (boolean `removed`, no `outcome`) | MISMATCH — field is `removed: boolean`, not `outcome: "revoked"` |
| docs/cli-contract.md | 291–294 | revoke exit codes 0 / 1 (failed or not found) / 2 (no KEY) | Exit codes | `revoke.ts` exits 0 even when `removed === false`; 2 handled in bin.ts | MISMATCH — failed/not-found revocation exits 0, not 1 |
| docs/cli-contract.md | 298–303 | `envseal mcp` starts MCP server over stdio | Shell | `mcp.ts` delegates to `envseal-mcp` binary (`packages/mcp-server/dist/bin.js`) | OK |
| docs/cli-contract.md | 309–312 | global flags `--project`/`--json`/`--help,-h`/`--version,-v` | Shell | bin.ts + parseArgs | OK |
| docs/cli-contract.md | 316–328 | JSON error format `{ code, userMessage, retriable }` | Schemas | `packages/cli/src/output.ts:fail()` | OK |
| docs/cli-contract.md | 334 | guarantee #1: no command prints a secret value | Prose | architecture + zero-leak tests | OK |
| docs/cli-contract.md | 335 | guarantee #2: redactor masks substrings as `«redacted:KEY_NAME»` | Prose | `packages/core/src/redact.ts` (label tokens require a `labels` map) — no caller passes labels, so output is always `«redacted»` | MISMATCH — the key-named token is never produced; actual mask is generic `«redacted»` |
| docs/cli-contract.md | 336 | guarantee #3: JSON output is single objects | Prose | `output.ts` `JSON.stringify` single object | OK |
| docs/cli-contract.md | 337 | guarantee #4: exit codes stable and documented | Prose | `exit-codes.ts` | OK |
| docs/cli-contract.md | 343–360 | integration example `ensure`/`verify`/`run` | Shell | all commands exist | OK |
| docs/cli-contract.md | 366–371 | testing: spawns real dist/bin.js, flows init→status→set→status→doctor, stub prompter via ENVSEAL_TEST_MODE=1 + ENVSEAL_TEST_PROMPTER_VALUE, asserts sentinel never in stdout/stderr | Shell/prose | `packages/cli/test/shell-e2e.test.ts`, `packages/cli/src/cli-utils.ts` (double-gated stub) | OK |
| spec/sep-1/SPEC.md | 26–83 | `env_describe` input/output schemas | Schemas | `EnvirDescribeInput`, `ManifestStatus`, `KeyStatus` in `packages/protocol/src/schemas.ts` (field names, enums, required, nullability match; `source` + `rotationDue` exist) | OK |
| spec/sep-1/SPEC.md | 80 | `lengthBucket` is a range like "48-64" | Numeric | `packages/core/src/broker.ts:getLengthBucket` buckets include `48-64` | OK |
| spec/sep-1/SPEC.md | 81 | fingerprint is an 8-character HMAC identifier | Numeric | `computeFingerprint` → `fp_` + 8 hex chars | OK (8 hex chars; full string is `fp_` + 8) |
| spec/sep-1/SPEC.md | 87–178 | `env_declare` input/output schemas (key pattern, description 280, defaults, provider, verify, sink enum incl `external`, rotation, strict) | Schemas | `ManifestEntry`/`DeclareResult` field-for-field | OK |
| spec/sep-1/SPEC.md | 172–174 | declare idempotent; strict; "MUST reject any entry containing a field named `value` or any value-shaped field" | Schemas/prose | `.strict()` rejects unknown fields incl `value`; no detector-based value-shape rejection in the declare path | MISMATCH — only a literal unexpected field (e.g. `value`) is rejected; arbitrary secret-shaped field content is not detected |
| spec/sep-1/SPEC.md | 175 | defaults filled from provider registry when `provider.id` known | Prose | `packages/core/src/broker.ts:declare()` (`findKey` by env var name) | OK |
| spec/sep-1/SPEC.md | 176 | `verify.url` must be https and not contain `{{value}}` (goes in headerTemplate) | Schemas/prose | `ManifestEntry.superRefine` enforces both | OK |
| spec/sep-1/SPEC.md | 177 | writes `env.schema.jsonc`, creates if absent | Prose/paths | `packages/core/src/manifest.ts` | OK |
| spec/sep-1/SPEC.md | 181–208 | `env_request` input/output schemas (`keys` min1, `reason` 1–280; Ticket with surface enum, expiresAt, userMessage) | Schemas | `EnvRequestInput`/`Ticket` | OK |
| spec/sep-1/SPEC.md | 212 | rejects with `SEP_NOT_DECLARED` if key not declared | Errors | `broker.request()` throws `SEP_NOT_DECLARED` | OK |
| spec/sep-1/SPEC.md | 213 | reason shown verbatim, no truncation | Prose | `broker.request`/`startPrompt` pass reason through | OK |
| spec/sep-1/SPEC.md | 215 | "Returns a ticket ID (ULID) and a display nonce (6 hex characters)" | Numeric | `packages/core/src/tickets.ts` (`ulid()`; nonce = 8 Crockford-base32 chars formatted `XXXX-XXXX`) | MISMATCH — the display nonce is 8 characters (4-4), not 6 hex |
| spec/sep-1/SPEC.md | 220–256 | `env_await` schemas (state enum, outcome enum, default keep) | Schemas | `EnvAwaitInput`/`TicketOutcome` | OK |
| spec/sep-1/SPEC.md | 228/259 | timeoutMs min 1000, max 120000, default 90000 | Numeric | `EnvAwaitInput` | OK |
| spec/sep-1/SPEC.md | 261 | on timeout the ticket remains live; env_await can be called again | Prose | `tickets.ts` (timeout leaves record `pending`) | OK |
| spec/sep-1/SPEC.md | 267–298 | `env_verify` schemas | Schemas | `EnvVerifyInput`/`VerifyResult` | OK |
| spec/sep-1/SPEC.md | 306 | "if the probe host is not on the allowlist, reject with `SEP_PROBE_NOT_APPROVED`" | Errors | `verifyKey` returns a classified `probe_not_approved` VerifyResult; the error code `SEP_PROBE_NOT_APPROVED` is never thrown | MISMATCH — the operation returns result `probe_not_approved`, it does not raise `SEP_PROBE_NOT_APPROVED` |
| spec/sep-1/SPEC.md | 310–336 | `env_use` schemas | Schemas | `EnvUseInput`/`ExecResult` | OK |
| spec/sep-1/SPEC.md | 342–343 | child env only, broker `process.env` unchanged; stdout/stderr redacted | Prose | `exec.ts` | OK |
| spec/sep-1/SPEC.md | 344 | `redactedCount` is "the number of distinct secret references removed from output" | Numeric | `redact.ts` count increments per replacement occurrence | MISMATCH — it is a count of masking replacements (occurrences), not distinct secret references |
| spec/sep-1/SPEC.md | 345 | "If the command contains network tools … requires user confirmation" | Prose | `exec.ts` requires confirmation for **every** command; egress only changes the warning | MISMATCH — confirmation is unconditional, not gated on network tools |
| spec/sep-1/SPEC.md | 346 | on denial returns `SEP_CONFIRMATION_DENIED` | Errors | `exec.ts` throws `SEP_CONFIRMATION_DENIED` | OK |
| spec/sep-1/SPEC.md | 350–376 | `env_revoke` schemas | Schemas | `EnvRevokeInput`/`RevokeResult` | OK |
| spec/sep-1/SPEC.md | 379–380 | "Removes the key from the sink"; "Requires user confirmation before deletion" | Prose | `broker.revoke()` calls `sink.remove` with **no** `onConfirm` step; no confirmation exists anywhere for revoke | MISMATCH — revoke performs no user confirmation (also mirrored in `packages/sdk/src/index.ts` tool description "after user confirmation") |
| spec/sep-1/SPEC.md | 382 | returns `rotateUrl` from registry | Prose | `broker.revoke()` falls back to registry rotateUrl | OK |
| spec/sep-1/SPEC.md | 383 | records revocation in audit log | Prose | `appendAudit({ type:'revoke' })` | OK |
| spec/sep-1/SPEC.md | 391–406 | error-code table (14 codes + retriable flags) | Errors | `SEP_ERROR_CODES` + `SEP_ERROR_DEFAULTS` — every code exists, retriable flags match | OK |
| spec/sep-1/SPEC.md | 410–457 | manifest rules (committed to git, key pattern, description 280, required/secret defaults, RE2-safe pattern, provider defaults, verify.url https/no-`{{value}}`, sink enum) | Schemas/prose | `Manifest`/`ManifestEntry`; sink enum includes `external` | OK |
| spec/sep-1/SPEC.md | 463 | loopback "single-use HTTP server bound to `127.0.0.1:0`" | Prose | `loopback.ts` (`listen(0, '127.0.0.1')`) | OK |
| spec/sep-1/SPEC.md | 467 | bind IPv4 loopback only, not ::1/0.0.0.0 | Prose | `loopback.ts` | OK |
| spec/sep-1/SPEC.md | 469 | "Generate a 128-bit path nonce and a 6-character display nonce (e.g. `7F2A-91C4`)" | Numeric | path nonce = `randomBytes(16)` (128-bit) OK; display nonce = 8 chars `XXXX-XXXX` (the example `7F2A-91C4` is 8 chars) | MISMATCH — "6-character" is wrong; the nonce is 8 characters (the example itself contradicts 6) |
| spec/sep-1/SPEC.md | 471 | open with `open`/`start`/`xdg-open` | Prose | `loopback.ts:openBrowser` | OK |
| spec/sep-1/SPEC.md | 473–476 | Host exact match → 400; Origin presence → 400; constant-time path nonce → 404 | Prose | `loopback.ts:serveRequest` | OK |
| spec/sep-1/SPEC.md | 478–483 | headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, CSP, `X-Frame-Options: DENY` | Prose | `securityHeaders()` — all listed present (plus `script-src` nonce and `base-uri 'none'`) | OK |
| spec/sep-1/SPEC.md | 484–491 | single-use page content: project path, verbatim reason, display nonce, per-key sections, reveal toggle, skip checkbox, `data-1p-ignore`, `data-lpignore`, `autocomplete="off"`, `spellcheck="false"` | Prose | `renderForm`/`renderKeySection` | OK |
| spec/sep-1/SPEC.md | 493 | POST submits to same path nonce with CSRF token bound to ticket | Prose | form posts to `/t/<pathNonce>`; hidden `csrf`; `serveRequest` validates | OK |
| spec/sep-1/SPEC.md | 495 | single-use response; immediately close listener; second request → connection refused | Prose | `finishPrompt` → `teardown` → `server.close()` + socket destroy | OK |
| spec/sep-1/SPEC.md | 497 | timeout: close listener, release port, "Mark the ticket `expired`" | Prose | prompter timeout closes listener but broker marks per-key `timeout` and resolves the ticket (`state:'resolved'`); ticket becomes `expired` only via TTL sweep | MISMATCH — the ticket is resolved (not `expired`) on prompter timeout |
| spec/sep-1/SPEC.md | 499 | no replay; editing replaces the value | Prose | form never shows stored values | OK |
| spec/sep-1/SPEC.md | 507–511 | probe approval: display details, explicit yes/no consent, record in `.envseal/approvals.json` keyed by (key, method, url, hash(headerTemplate)), replay without re-ask, re-ask on change | Prose | `approvals.ts` matches data/keyed consent; but `onApprovalNeeded` is never supplied by CLI/MCP/HTTP/SDK — no consent UI exists in shipped bindings; verify returns `probe_not_approved` instead | MISMATCH — the consent-UI step is not reachable through any shipped binding |
| spec/sep-1/SPEC.md | 534 | refuses rather than degrades — `SEP_NO_INTERACTIVE_SURFACE` | Errors | `none.ts` | OK |
| spec/sep-1/SPEC.md | 536–541 | reference implementations exist at `packages/core/src/`, `mcp-server/src/`, `cli/src/`, `sdk/src/`, `http-server/src/` | File paths | all directories exist | OK |

## Notes on numeric claims listed in the task brief

- **"37 providers" / "30+"** — no such count appears in any of the six documents, so there is no claim to verify. (For the record: `packages/registry/providers/*.json` contains exactly 37 provider files, satisfying the "at least 30" registry test.)
- **64 KiB body cap** — the six documents never state a 64 KiB cap. It exists in code (`packages/prompters/src/loopback.ts:MAX_BODY_BYTES = 64 * 1024`) but is undocumented; the HTTP server uses a different 1 MiB cap. No doc claim to contradict.

## Findings, priority order

1. **Sinks that are stubs are documented as working — the largest doc/behavior gap.** README (lines 40–43 diagram, 60), residual-risks (28–30, 50, 156) present `vault`, `sops`, `onepassword`, `doppler` as destinations for secret values. In code they are `UnimplementedSink`s that throw `SEP_SINK_UNAVAILABLE`, and even `keychain` is write-only (`read()` returns null, `remove()` returns false). *Fix:* qualify these as "declared/planned (not yet implemented)" everywhere a sink list appears; refer to `dotenv` and `keychain` as the only working sinks.

2. **MCP "streamable HTTP" / "http+sse" transport does not exist.** README (32, 94) promises stdio + streamable HTTP (and an http+SSE connect mode); `packages/mcp-server/src/bin.ts` parses `--http`/`--port` but always uses `StdioServerTransport`, and no SSE/streamable-HTTP code exists. *Fix:* either implement the HTTP transport or document Tier 1 as stdio-only.

3. **Probe-approval consent UI is never wired.** SPEC (507–511) and threat-model T8 (50) describe an explicit consent flow (`onApprovalNeeded`) with the host displayed and yes/no consent recorded in `.envseal/approvals.json`. The mechanism exists in `verify.ts`/`approvals.ts`, but no shipped binding (CLI, MCP, HTTP, SDK) ever supplies `onApprovalNeeded`, so in practice `env_verify` just returns `probe_not_approved`. *Fix:* wire the callback in the CLI/MCP (display method+URL+headerTemplate and prompt) or amend the docs to say consent is currently a host-supplied callback.

4. **cli-contract.md JSON output shapes differ from the real CLI — the "machine-readable contract" is the most concrete surface and it is wrong in five places:**
   - init JSON (31–38): docs claim `initialized` + `message`; code emits `manifestPath, host, protectionTier, scanned, added, updated, unchanged, secretKeys, configKeys, entries`. *Fix:* document the real fields.
   - revoke JSON (283–289): docs claim `"outcome": "revoked"`; code emits `removed: boolean`. *Fix:* use `removed` (or change the CLI).
   - run JSON (205–212): live output adds `redactedCount`; *Fix:* document it.
   - ensure JSON (53–59): `total` is absent when all keys are already present. *Fix:* always emit `total` (or document the variant).
   - cli-contract guarantee #2 (335): claims masks are `«redacted:KEY_NAME»`; no caller passes a labels map, so the actual mask is always `«redacted»`. *Fix:* state the generic mask, or thread labels through `exec.ts`.

5. **cli-contract.md exit codes for `set`, `ensure`, `revoke` don't match behaviour.**
   - `set` (87–93): "1 — Key not stored" only happens via a generic "No outcome returned" error in CI; a real user-cancel/timeout exits 0; codes 3/4 are never produced. *Fix:* make the CLI exit 1 (or 3) on non-stored outcomes, or correct the table.
   - `ensure` (61–65): codes 3 (cancelled) and 4 (no surface) are unreachable — a cancelled / no-surface ticket just exits 1. *Fix:* surface `SEP_NO_INTERACTIVE_SURFACE` from `ensure` in CI and map cancel to 3.
   - `revoke` (291–294): "1 — failed or not found" never happens; a failed revoke exits 0. *Fix:* exit 1 when `removed === false`.

6. **SPEC `env_revoke` "Requires user confirmation before deletion" (380) is not implemented** — `broker.revoke()` calls `sink.remove` with no confirmation step (the SDK tool description repeats the same untrue claim). *Fix:* either implement confirmation or delete the sentence (and fix the SDK description).

7. **SPEC `env_verify` (306) says "reject with `SEP_PROBE_NOT_APPROVED`"** — the code returns a classified `probe_not_approved` result (never raises the error code). *Fix:* align the sentence with the returned-result behaviour.

8. **Display nonce size is wrong in SPEC (215 and 469):** documents say "6 hex characters"; `tickets.ts`/`types.ts` produce 8 Crockford-base32 characters formatted `XXXX-XXXX` (the SPEC's own example `7F2A-91C4` is 8 chars). *Fix:* say "8-character `XXXX-XXXX`".

9. **`env_use` confirmation described as conditional on network (README 109/120, SPEC 345, residual-risk 13)** — the code requires confirmation for every command; only the warning is egress-specific. *Fix:* state that all `env_use` runs are confirmed, with an extra egress warning.

10. **README `env_await` outcome list (118) omits `skipped`** (and no "e.g." hedge). *Fix:* add `skipped`.

11. **residual-risks #5 "opens an HTTPS page" (116) is wrong** — the loopback prompter serves plain HTTP on `127.0.0.1`. *Fix:* say HTTP (which is also why #5's TLS concerns are moot).

12. **residual-risks CSP quote (122) is a subset** of the real policy (`style-src`/`script-src` nonces, `base-uri 'none'` added). Protective claim still holds; *Fix:* quote the real header or say "a CSP that blocks external requests".

13. **Threat-model T3 (45) and SPEC (174) overclaim "any value-shaped field is rejected"** — only a literal `value`/unknown field is rejected by `.strict()`; the secret-shaped detector is not consulted in the declare path. *Fix:* narrow the claim to "unknown/`value` fields are rejected".

14. **Threat-model T13 (55) and residual-risk #2 (38–39) claim values are converted to string only in the sink writer** — `unsafeSecretToUtf8` is also used for child-env injection (`exec.ts`), redaction variants (`redact.ts`) and probe headers (`verify.ts`). *Fix:* acknowledge these conversion points.

15. **Threat-model T12 (54): `SecretValue` is not "a branded type with no toString"** — it is a `Buffer` and has `toString()`; the real defence is the `no-secret-to-log` eslint rule, which lives in `eslint.config.js`, not the non-existent `.eslintrc`. *Fix:* correct the file reference and drop "no toString".

16. **Threat-model T7 (49): "offers to add `.env` to gitignore" and "explicit override" are not implemented** — only the hard `SEP_GITIGNORE_UNSAFE` refusal exists; `allowUnsafe` is an unused low-level option. *Fix:* either add the offer/override to the CLI or describe only the refusal.

17. **SPEC `redactedCount` (344) is documented as "distinct secret references"** but the code counts masking replacements (occurrences). *Fix:* reword to "number of masked occurrences".

18. **SPEC loopback timeout "mark the ticket `expired`" (497)** — the broker resolves the ticket (`state: 'resolved'`) with per-key `timeout` outcomes; `expired` only results from TTL sweep. *Fix:* align with the resolve-on-timeout behaviour.

19. **README native-dialog (49) says "WinForms"; Windows uses PowerShell `Read-Host -AsSecureString`** (and Linux is zenity/kdialog/ssh-askpass). *Fix:* say "PowerShell/osascript/zenity".

20. **Minor (informational):** `SEP_TICKET_EXPIRED`, `SEP_TICKET_UNKNOWN`, `SEP_USER_CANCELLED`, `SEP_RATE_LIMITED` exist in `SEP_ERROR_CODES` but no code path in the reference implementation ever throws them (await maps to state/outcome instead). Not a doc error per se, but a spec-conformance caveat a publisher may want to note.
