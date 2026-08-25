# Security hardening plan (Composer 2.5 execution)

This is the execution plan for closing the findings from the 2026-08-25 whole-repo security review. It is written so an **orchestrator** can dispatch **Composer 2.5** subagents with disjoint file ownership, then merge and verify.

**Product:** envseal — local SEP/1 broker. Secrets travel User → prompter → broker → sink. The model must never see values.

**Do not read:** `.env`, `.env.*`, `.envseal/*`, `*.pem`, `*.key`, `credentials.json`, `secrets.json`.

**Do not edit:** `marketing/`, launch-video assets, vendor lockfile churn unrelated to a finding.

---

## 0. How to run this with Composer 2.5

### Orchestrator rules

1. Stay on one feature branch (`cursor/security-hardening-347b` or this plan’s branch).
2. Dispatch **one wave at a time**. Never two agents on the same file.
3. Model: `composer-2.5-fast` (or `composer-2.5` if that slug is available). `subagent_type: generalPurpose`.
4. Each agent prompt must include: objective, owned paths, forbidden paths, tests to run, acceptance criteria, and “do not expand scope.”
5. After each agent: `pnpm --filter <pkg> test` (and typecheck if it touched `.ts`). If red, resume **that** agent with the failure output — do not start the next wave.
6. After Wave 4: full `pnpm test && pnpm test:zero-leak && pnpm lint`.
7. Update `docs/threat-model.md` and `docs/residual-risks.md` only in Wave 5 (docs agent), after code lands.

### Shared prompt footer (append to every agent)

```text
Repo root: <absolute path>
Branch: already checked out; do not switch branches.
Follow existing style. No drive-by refactors. No new dependencies unless a finding requires it.
Every behaviour change needs a test that would have failed before the change.
If you cannot implement without a product decision listed in the plan, stop and report the blocker — do not guess.
Never print real secrets. Tests use FAKE / X-filled sentinels like existing fixtures.
When done: list files changed, tests run, leftover risk.
```

### File locks (never overlap in the same wave)

| Lock ID | Paths |
|---------|--------|
| L-HOOK | `plugins/claude-code/hooks/**`, `plugins/claude-code/test/pre-tool-use.test.ts` |
| L-PROTO | `packages/protocol/**` |
| L-DET | `packages/detector/**` |
| L-CORE | `packages/core/**` |
| L-MCP | `packages/mcp-server/**` |
| L-SDK | `packages/sdk/**` |
| L-HTTP | `packages/http-server/**` |
| L-CLI | `packages/cli/**` |
| L-CI | `.github/workflows/**`, `docs/publishing.md` |
| L-DOCS | `docs/threat-model.md`, `docs/residual-risks.md`, `README.md` (only Wave 5) |
| L-REG | `packages/registry/**` (schema HTTPS only; Wave 1C may read but Wave 2 owns schema change) |

---

## 1. Classification (what to fix vs leave)

### 1.1 Must fix (bugs vs stated threat model)

| ID | Finding | Why it is a bug |
|----|---------|-----------------|
| H1 | `source .env` / `. .env` not denied | T2 claims env-file reads are blocked |
| H2 | `env -i cat .env` / flagged `env` wrappers skip unwrapping | Same |
| H3 | `busybox cat .env` not unwrapped | Same |
| H4 | macOS keychain write puts secret on argv | Core policy is stdin-only (`cli-sink-base.ts`) |
| H5 | JSONC comments can hold secrets in `env.schema.jsonc` | T3 “no values in the manifest file” |
| H6 | Unbounded `format.pattern` → `new RegExp` | Local ReDoS of the broker |
| H7 | Detector drops unprefixed secrets in JSON/code-shaped text | T4 overclaims prefix/generic coverage |
| H8 | Detector ignores registry `format.pattern` | Same |
| H9 | `env_revoke` has no confirmation | Dialect JSON already promises it |
| H10 | `assertGitSafe` no-ops outside git | T7 only holds inside a work tree |
| H11 | `.env` mode not forced after rename | Writes can leave world-readable files |
| H12 | `env_use` silently skips missing/undeclared keys | Partial injection / false consent |

### 1.2 Should harden (not a protocol lie, still worth doing)

| ID | Finding | Intended fix |
|----|---------|----------------|
| S1 | Hook fail-open on internal error | Keep default fail-open (documented). Doctor + stderr already exist. Add tests that crash path is explicit. Optional: `envseal doctor` prints fail-open vs `ENVSEAL_HOOK_FAIL_CLOSED=1`. **Do not flip the default.** |
| S2 | Nesting depth cap fail-open | Raise `MAX_PAYLOAD_DEPTH` from 3 → 6 **or** deny when depth exceeded instead of skipping. Prefer **deny when depth exceeded** (fail closed on that one heuristic). |
| S3 | Global `~/.envseal/api-token` | Keep file for compat. Prefer **per-listen ephemeral token** when none is passed in; persist only if `ENVSEAL_PERSIST_HTTP_TOKEN=1` or existing file already present. Doctor warns if user-wide token exists. |
| S4 | MCP `redact(text, [])` | Pass through a no-value pattern redact is OK; add a comment-enforced test that `asContent` never gains a secret list (broker remains the value-aware layer) **or** thread declared-key names only — **do not** pass live `SecretValue` into MCP. Prefer: keep empty list but add `redact(text)` pattern-only assertion in `egress.test.ts`. Skip if already equivalent. |
| S5 | Doctor gitignore is substring | Use the same `git check-ignore` / `ls-files` logic as the sink (or call a shared helper). |
| S6 | Probe headline unescaped `entry.key` | Run `escapeForDisplay(entry.key)` in MCP/SDK `confirm.ts` twins. |
| S7 | Registry `verify.url` allows `http://` | Mirror ManifestEntry: HTTPS-only in `ProviderSchema`. |
| S8 | CI actions floating `@v4` | Pin `actions/checkout`, `pnpm/action-setup`, `actions/setup-node` to full commit SHAs; comment the tag. |
| S9 | Release lint weaker than CI | Release job: `pnpm lint --max-warnings 0`. |
| S10 | `workflow_dispatch` can publish any ref | Require `github.ref` to match `refs/tags/v*` when `dry-run == false`. |
| S11 | Release omits example-demo probe | Add `node scripts/probe-example-demo.mjs` before publish. |

### 1.3 Do not “fix” (by design / API break / out of host control)

| ID | Item | Action |
|----|------|--------|
| L1 | Child inherits full `process.env` | Document only (already in `exec.ts` + residual-risks). |
| L2 | `MIN_SECRET_LENGTH = 8` | Document only. Lowering causes FPs; raising leaks short PINs. |
| L3 | Egress detection heuristic | Document only. Allowlist mode is the real control. |
| L4 | MCP stdio has no auth | Document only. Trust is the host. |
| L5 | IDE socket `cancel` without token | Document only (DoS, not secret read). |
| L6 | `ENVSEAL_ASSUME_YES` on CLI `run` | Keep. Human-typed CLI. Do not add to MCP/SDK. |
| L7 | `ENVSEAL_TEST_MODE` double gate | Keep. |
| L8 | 32-bit describe fingerprint | Do not lengthen (clients may persist `fp_`). Note confirmation-oracle in residual-risks. |
| L9 | `SecretValue` compile-time brand | Keep eslint `no-secret-to-log`. No runtime wrapper. |
| L10 | Cursor / Aider / Continue have no T2 hook | Cannot enforce. Doctor already reports tier. Optional one-line README. |
| L11 | `/proc/<pid>/environ` | Residual-risks only. |
| L12 | Provenance e2e verify | Optional later; not blocking this pass. |

---

## 2. Dependency graph

```text
Wave 1 (parallel):  H1–H3+S1+S2 (hooks)
                    H6+H9 error codes (protocol)     [protocol first if core needs new codes]
                    H7+H8 (detector)
                    S8–S11 (CI)   — no TS coupling

Wave 2 (after protocol): H4, H10, H11, H12, H6 compile, H9 broker confirm, H5 scan on load (core)
                         S7 (registry schema)

Wave 3 (after core): H9 wire MCP/SDK/HTTP confirm
                     S3 HTTP token
                     S5+S1 doctor (CLI)
                     S6 confirm headline escape

Wave 4: H5 hook policy for env.schema.jsonc comments (hooks, after detector+core)
        Zero-leak + dialect JSON descriptions

Wave 5: docs only
```

Protocol must land **before** core if you add `SEP_KEYS_MISSING` / `SEP_PATTERN_UNSAFE`. Hooks Wave 1 does not need protocol.

---

## 3. Wave 1 — parallel agents

### Agent A — Claude Code PreToolUse (lock L-HOOK)

**Objective:** Close T2 bypasses without turning the hook into a sandbox.

**Owned files:** `plugins/claude-code/hooks/pre-tool-use.ts`, `plugins/claude-code/test/pre-tool-use.test.ts`. Rebuild hook bundle if the package script does that (`plugins/claude-code` build).

**Implement:**

1. Treat `source` and `.` (dot) as file-readers when their operand matches secret paths (`.env`, `.env.*`, declared files). Recurse into `source file` the same way `cat file` is handled.
2. Wrapper stripping: if head is `env` **and** the next tokens are flags (`-i`, `-u`, `-C`, `--`), keep stripping until a non-flag command head appears, then classify that head. `env -i cat .env` must deny.
3. Add `busybox` (and `busybox.exe` on Windows if that path exists) to WRAPPERS / unwrap `busybox cat`.
4. When `MAX_PAYLOAD_DEPTH` is exceeded: **deny** with a fixed reason (`envseal hook: command nesting too deep`), do not skip.
5. Keep `internalErrorDecision()` fail-open default. Add/keep a test for `ENVSEAL_HOOK_FAIL_CLOSED=1`.

**Tests to add (table-driven next to existing bash cases):**

- `source .env`, `. ./.env`, `source .env.local`
- `env -i cat .env`, `env -u PATH cat .env`
- `busybox cat .env`
- `sh -c 'sh -c 'sh -c 'sh -c cat .env'''` (depth) → deny
- Existing allow cases still allow (`echo hello`, `npm test`)

**Run:** `pnpm --filter @envseal/plugin-claude-code test && pnpm --filter @envseal/plugin-claude-code build` (rebuild `hooks/dist` so bundled CJS matches source).

**Forbidden:** Changing fail-open default; matching non-Bash MCP file tools.

---

### Agent B — Protocol (lock L-PROTO)

**Objective:** Make unsafe patterns and missing keys first-class errors.

**Owned files:** `packages/protocol/src/errors.ts`, `packages/protocol/src/schemas.ts`, `packages/protocol/test/schemas.test.ts`, `packages/protocol/test/errors.test.ts`, generated JSON schemas if `gen-schemas` is in the package scripts.

**Implement:**

1. Add codes (names can match existing style):
   - `SEP_PATTERN_UNSAFE` — format.pattern rejected (length / complexity).
   - `SEP_KEYS_MISSING` — `env_use` asked for keys that are undeclared or have no stored value.
2. `format.pattern`:
   - max length **256**
   - reject if it contains nested unbounded quantifiers that are known ReDoS shapes **or** (simpler, preferred): compile with a **timeout-free linear check**:
     - allow only a conservative subset: character classes, `{m,n}` with n ≤ 256, no `(a+)+`, no `\n` unbounded
   - Practical approach that fits this codebase: `z.string().max(256).refine(isLinearishRegex)` where `isLinearishRegex` rejects `+`/`*` applied to something that already has `+`/`*`, and rejects patterns longer than 256.
3. `ManifestEntry` and registry consumers share the same refine if the helper is exported from protocol.

**Tests:**

- `format.pattern` of 10k `a+` rejected
- `(a+)+$` rejected
- `^sk-[A-Za-z0-9]{20,80}$` accepted
- New error codes appear in `SEP_ERROR_CODES` and defaults

**Run:** `pnpm --filter @envseal/protocol test && pnpm --filter @envseal/protocol build`

**Forbidden:** Changing fingerprint length; loosening `.strict()`.

---

### Agent C — Detector (lock L-DET)

**Objective:** Restore T4 recall for prefix-less and registry-pattern keys without blowing the 1% FP budget.

**Owned files:** `packages/detector/src/**`, `packages/detector/test/**` (especially `exclusions.ts`, `patterns.ts`, `index.ts`, `metrics.test.ts`, `exclusions.test.ts`).

**Implement:**

1. `isCodeAdjacent()`: do **not** drop a generic hit when the token entropy/length would already qualify **and** the adjacent punct is JSON/JS structural (`:`, `,`, `{`, `}`). Current bug: `{"secret":"<32 alnum>"}` is excluded. Fix: code-adjacent exclusion applies to **identifiers** (has camelCase dictionary word / starts with `$`) not to high-entropy `[A-Za-z0-9]{32,}`.
2. `allPrefixPatterns()`: also compile registry `format.pattern` as high-confidence detectors when the pattern is bounded (after Agent B, patterns are safer). If Wave 1C runs **before** protocol, only ingest patterns that already have `{m,n}` and length < 256.
3. Prefix synthesis: if body allows `_` (Clerk `sk_test_…`), do not require `[A-Za-z0-9]{16,}` only — use the registry pattern when present.
4. Re-run metrics gates: **do not merge if** `metrics.test.ts` thresholds fail. If a change breaks FP, tighten exclusions with a new fixture, don’t disable the test.

**Tests:**

- JSON object value with 32-char alnum → detection
- Registry key with pattern-only format (pick Discord/Auth0 from `packages/registry/providers`) → high confidence
- Existing digest/data-URI/path exclusions still hold (`exclusions.test.ts`)

**Run:** `pnpm --filter @envseal/detector test`

**Forbidden:** Logging matched secret text in findings (shape tests must stay offsets/labels only).

---

### Agent D — CI / release (lock L-CI)

**Objective:** Supply-chain pins and release/CI parity.

**Owned files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/publishing.md` (pin table only).

**Implement:**

1. Replace `@v4` with `actions/<name>@<40-char-sha>  # v4.x.x`. Resolve SHAs from GitHub at implementation time (do not invent).
2. Release lint: `pnpm lint --max-warnings 0`.
3. When `workflow_dispatch` and `dry-run == false`, fail unless `startsWith(github.ref, 'refs/tags/v')`.
4. Run `node scripts/probe-example-demo.mjs` in release after tests, before publish.

**Tests:** N/A (workflow). Orchestrator validates YAML still parses.

**Forbidden:** `pull_request_target`; printing `secrets.NPM_TOKEN`.

---

## 4. Wave 2 — core + registry (serial with protocol)

Dispatch **two** agents only if they split files:

- Agent E: `packages/core/**` except nothing in detector
- Agent F: `packages/registry/src/schema.ts` + `packages/registry/test/safety.test.ts`

If one Composer context can hold both, prefer **one** core+registry agent to avoid schema drift.

### Agent E — Core broker/sinks (lock L-CORE)

**Depends on:** Agent B merged.

**Implement:**

#### H6 — compile-time pattern

In `broker.ts` (and any other `new RegExp(entry.format.pattern)`): catch invalid / unsafe patterns and throw `SEP_PATTERN_UNSAFE` rather than hanging. Do not rely only on Zod — defensive try/catch around `new RegExp`.

#### H12 — `env_use` missing keys

In `Broker.use`:

- If a requested key is not in the manifest → `SEP_NOT_DECLARED` (already exists) or `SEP_KEYS_MISSING` listing **names only**.
- If declared but `sink.read` is null → `SEP_KEYS_MISSING`.
- **Never** spawn with a subset. Fail before `runWithSecrets`.
- Consent dialog must only be reachable after this check (or include only keys that will actually inject — but failing closed is simpler).

Tests in `packages/core/test/broker.test.ts` / `exec.test.ts`.

#### H9 — revoke confirmation

`Broker.revoke` must call the same class of user confirmation as `env_use`:

- Reuse `onConfirm` **or** add `onRevokeConfirm?: (keys: string[]) => Promise<boolean>`.
- Prefer extending `onConfirm` with a discriminant so MCP/SDK twins don’t invent a third prompt stack: e.g. `onConfirm({ kind: 'use' | 'revoke', ... })`.
- If that is too invasive, add `onRevokeConfirm` and wire it in Wave 3 exactly like `createUseConfirmation`.
- No `ENVSEAL_ASSUME_YES` in MCP/SDK. CLI `envseal revoke` may keep a `--yes` if one exists; if not, require TTY confirm.
- Timeout / no surface → existing `SEP_NO_INTERACTIVE_SURFACE` / `SEP_TICKET_EXPIRED` mapping used by use-confirm.
- Denied → `SEP_CONFIRMATION_DENIED`.
- Do not delete any key until confirm returns true.

Tests: revoke without confirm hook fails closed; with hook approving, `sink.remove` runs once.

#### H4 — macOS keychain argv

`packages/core/src/sinks/keychain.ts` Darwin `write()`:

- Secret must not appear in `spawn` `args`.
- Preferred: `security add-generic-password … -w` with password **omitted** and bytes on stdin, if `man security` on Darwin supports it.
- If stdin is not accepted non-interactively, use a **0600 temp file** + `-w "$(<file)"` is **forbidden** (still argv). Use `security import` or Apple’s documented `-i` only if it does not echo argv.
- **Verify on macOS** (`pnpm --filter @envseal/core test` already runs keychain tests; add a unit test that mocks `execCommand` and asserts `args` has no secret string).
- Windows/Linux paths stay stdin/DPAPI as today.

#### H11 — dotenv mode

After `renameOverwrite` in `dotenv.ts`, on POSIX `chmodSync(target, 0o600)`. If Windows cannot chmod, document; still attempt.

Test: create world-readable `.env` (`0o644`), write a key, `stat` mode is `0o600` (skip on win32).

#### H10 — git-safe without repo

Change `assertGitSafe`:

- If not a git work tree: **refuse** with `SEP_GITIGNORE_UNSAFE` unless `.gitignore` in `paths.root` exists and `gitignore` matching is done **without git** (minimatch / ignore library already? If not, require a `.gitignore` that contains a line that would match `.env` using the same rules as `git check-ignore` **or** a simpler rule: file named `.env` + root `.gitignore` contains `.env` as a whole line / pattern).
- Preferred robust approach: if `git` unavailable or not a work tree, require `allowUnsafe` (CLI must **not** expose this) **and** existence of `.gitignore` covering `.env` via a small ignore matcher. Do not write plaintext secrets into a folder that will be `git init`’d later with no ignore.
- Test: tmp dir without `.git` → write throws; tmp dir with `.gitignore` containing `.env` → write succeeds; tmp dir with git + tracked `.env` still throws.

#### H5 — scan raw jsonc text

In `loadManifest` / `declareEntries` (`manifest.ts` + `guard.ts`):

- Run `scanText` on the **raw file string**, not only parsed fields.
- If comments (or any non-schema text) look secret-shaped → `SEP_VALUE_IN_REQUEST` (or keep that code for request injection; reuse it).
- Do not put matched text in the error `details`.

Tests in `secret-guard.test.ts` / `manifest.test.ts`: file with `// sk-proj-FAKE...` refuses.

**Run:** `pnpm --filter @envseal/core test && pnpm --filter @envseal/core typecheck`

**Forbidden:** Passing values to logger; `shell: true`; exposing `allowUnsafe` on the public CLI.

---

### Agent F — Registry schema (lock L-REG)

**Implement:** `verify.url` must be `https://` (same superRefine as `ManifestEntry`). Tests in `safety.test.ts` already expect HTTPS — move enforcement into Zod so a bad JSON cannot ship.

**Run:** `pnpm --filter @envseal/registry test`

---

## 5. Wave 3 — bindings (parallel MCP, SDK, HTTP, CLI)

Keep confirm **twins** in sync (`packages/mcp-server/src/confirm.ts` and `packages/sdk/src/confirm.ts`). Prefer extracting revoke body next to `useConfirmationBody` in `@envseal/core` `display.ts` so the twins cannot drift.

### Agent G — MCP + SDK (locks L-MCP then L-SDK, or one agent if sequential)

1. Wire revoke confirmation (same `yes`/`y` gate, single-flight mutex, no assume-yes).
2. Update tool description in `packages/mcp-server/src/tools/revoke.ts` to match dialect (“after user confirmation”).
3. `packages/mcp-server/spec/sep-1/dialects/mcp.tools.json` — already claims confirmation; keep in sync.
4. S6: `escapeForDisplay(entry.key)` in probe headline.
5. Tests: `env-use.test.ts` pattern cloned for revoke; `confirm.test.ts` for headline escaping (`key` with `\n` / ANSI).
6. Zero-leak: revoke path still never returns values (`zero-leak.test.ts`).

**Run:** `pnpm --filter @envseal/mcp-server test && pnpm --filter @envseal/sdk test`

### Agent H — HTTP (lock L-HTTP)

1. Same revoke confirm via existing `createUseConfirmation` / new revoke helper used by `startHttpServer`.
2. **S3 token:** If `opts.token` set, use it. Else if `ENVSEAL_PERSIST_HTTP_TOKEN=1` or `~/.envseal/api-token` already exists, keep current `getOrCreateToken()`. Else generate an **ephemeral** 128-bit token for this listen, print/return it with the URL, do not write the user-wide file.
3. Tests in `contract.test.ts`: ephemeral mode does not create `api-token` when the file was absent; persisted mode still 0o600.

**Run:** `pnpm --filter @envseal/http-server test`

### Agent I — CLI (lock L-CLI)

1. `doctor`: report hook fail-open vs fail-closed; replace `.includes('.env')` with shared git-ignore helper (import from core if exported, or duplicate the two `git` invocations already in dotenv — **prefer export** `assertGitIgnoreStatus()` from core without throwing).
2. `revoke` command: interactive confirm unless existing `--yes` for humans (not documented for agents).
3. Tests: `packages/cli/test/contract-e2e.test.ts` / doctor tests.

**Run:** `pnpm --filter @envseal/cli test`

---

## 6. Wave 4 — hook vs jsonc + integration

### Agent J — Hook jsonc comments (lock L-HOOK again, after Wave 2)

Today tests **allow** `Read env.schema.jsonc`. After core refuses secret-shaped comments on load, the remaining hole is the model **reading** a dirty file that was edited by hand.

**Implement:** On Read/Grep of `env.schema.jsonc`, run the detector on file contents (same as user-prompt-submit). If high-confidence hits in the file, **deny the Read** with “manifest contains secret-shaped text; rotate and remove it; use envseal to store values.” Keep allowing clean jsonc reads.

**Tests:** fixture file with comment `sk-` prefix → Read denied; clean jsonc → allowed.

**Run:** plugin tests + `pnpm test:zero-leak`

---

## 7. Wave 5 — documentation (lock L-DOCS)

Update, do not market:

- `docs/threat-model.md` T2/T3/T4/T7 rows: describe new controls honestly (hook still heuristic; fail-open default unchanged).
- `docs/residual-risks.md`: fingerprint confirmation oracle; user-wide HTTP token when persisted; argv keychain **removed** if H4 landed.
- README: Cursor still advisory (one sentence if missing).

No new features in this wave.

---

## 8. Suggested Composer 2.5 prompts (copy-paste)

### Wave 1A

```text
You are implementing envseal security finding H1–H3 and S2 only.
Owned: plugins/claude-code/hooks/pre-tool-use.ts and plugins/claude-code/test/pre-tool-use.test.ts
Read docs/security-hardening-plan.md section Agent A.
Do not change fail-open default (S1). Deny when MAX_PAYLOAD_DEPTH exceeded.
Add tests listed in the plan. Run the plugin test script.
```

### Wave 1B

```text
Implement protocol changes in docs/security-hardening-plan.md Agent B.
Owned: packages/protocol/** only.
Export SEP_PATTERN_UNSAFE and SEP_KEYS_MISSING. Bound format.pattern.
Run protocol tests and build. Update gen-schemas if that is how JSON schema is produced.
```

### Wave 1C / 1D

Use the matching section titles **Agent C** and **Agent D** from this file as the full spec.

### Wave 2E

```text
Implement docs/security-hardening-plan.md Agent E (core).
Protocol already has SEP_PATTERN_UNSAFE and SEP_KEYS_MISSING on this branch — use them.
Owned: packages/core/**
Do not expose allowUnsafe on the CLI. Do not put secrets on argv. Mock execCommand for Darwin keychain.
```

---

## 9. Acceptance (orchestrator gate)

Merge is ready when:

- [ ] `pnpm test`
- [ ] `pnpm test:zero-leak`
- [ ] `pnpm lint` (zero warnings)
- [ ] `pnpm typecheck`
- [ ] New tests exist for every H-id in §1.1
- [ ] No secret sentinel appears in MCP/HTTP/SDK zero-leak outputs
- [ ] `docs/threat-model.md` matches behaviour
- [ ] Darwin keychain test asserts argv has no secret (even if Darwin `security` is mocked)

---

## 10. Product decisions already made (do not re-litigate in agents)

1. Hook **fail-open** stays the default.
2. CLI `--yes` / `ENVSEAL_ASSUME_YES` stays for human CLI `run`, never MCP/HTTP/SDK.
3. HTTP user-wide token stays as opt-in / existing-file compat, not the default for new installs.
4. Fingerprint width unchanged.
5. No Cursor runtime hook in this pass.

If an agent hits a new decision, it stops and reports; the orchestrator decides.
