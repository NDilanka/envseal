# W4 — Test-suite quality audit

**Scope:** the tests, not the code. 48 test files across 10 packages plus `plugins/claude-code`.
**Method:** pattern sweep for un-failable and conditional assertions, then deliberate mutation of
each package's headline claim to confirm the suite actually goes red.

**Headline result:** 10 of 10 mutated subjects produced a red suite. Two of them went red only via
a *different* test than the one nominally guarding the claim, and one security test class
(`denial messages have alternatives`) stayed **green** through a mutation that disabled `.env`
protection entirely — the exact failure mechanism catalogued in VERIFICATION.md §0.

19 findings (F1–F19): **15 fixed**, 4 documented and left in place with written justification
(F15–F18). No assertion was weakened.

By category: **Cat 1** (cannot fail) 5 · **Cat 2** (conditional) 8 · **Cat 3** (source not artifact) 2 ·
**Cat 4** (repo as project root) 3 · flaky oracle 1.

---

## 1. Findings

Category key: **1** assertion that cannot fail · **2** conditional assertion ·
**3** test imports source where a built artifact is the deliverable · **4** project root is the repo.

| # | file:line | Cat | Why it is weak | Action |
|---|---|---|---|---|
| F1 | `plugins/claude-code/test/pre-tool-use.test.ts:339` | 2 | `if (!decision.allow)` wrapped the entire body of four `denial has alternative suggestion` cases. A `decide()` that started **allowing** `.env` made the condition false and the tests passed with zero assertions. **Proven:** stayed green under mutation M10 while six sibling tests failed. | **Fixed** — unconditional `expect(decision.allow).toBe(false)` before the narrowing. Re-run under M10: now red. |
| F2 | `packages/core/test/dotenv.test.ts:167–181` | 2 | The `git`-safety test wrapped its own assertions in `try { … } catch {}`. A `setDotenvValue` that happily wrote to a git-tracked `.env` threw an `AssertionError` that the same `catch` swallowed. The inner `if (error instanceof SepError)` additionally hid a wrong error type. The `SEP_GITIGNORE_UNSAFE` guarantee was untested. | **Fixed** — only the git *setup* may be skipped; assertions are unconditional. Verified red under bonus mutation M11 (`assertGitSafe` no-op); the old form would have passed. |
| F3 | `packages/registry/test/safety.test.ts:20,37,54` | 2 | All three provider-safety tests bodied out under `if (result.success)` with no assertion that parsing succeeded. A schema change that stopped provider files parsing would leave three green tests asserting nothing — and these are the exfiltration guards (`verify.url` must be `https://`, must not contain `{{value}}`). | **Fixed** — unconditional `expect(result.success).toBe(true)` per file, a new `every provider file parses` guard test, and a `checked > 0` counter so the tests cannot pass vacuously if no provider declares a `verify` block (only 7 of 37 do). |
| F4 | `packages/registry/test/examples.test.ts:22,51` | 2 | Same `if (result.success)` swallow. A parse failure skips the body, leaves `failures[]` empty, and `expect(failures).toHaveLength(0)` passes on the regression it guards. | **Fixed** — unconditional parse assertion. |
| F5 | `packages/mcp-server/test/dialects.test.ts:10–14` | 2 | `execSync('pnpm gen:dialects')` failure was caught and `console.error`'d. If the generator broke, every assertion below validated the **stale committed JSON** instead of fresh output. | **Fixed** — the swallow removed; a generator failure now fails the suite. |
| F6 | `packages/mcp-server/test/dialects.test.ts:104–108` | 1 | Same swallow in the determinism test. If regeneration silently failed, `content2` was a re-read of the untouched file, so `expect(JSON.stringify(data1)).toBe(JSON.stringify(data2))` compared a file to itself and **could not fail**. | **Fixed** — swallow removed. |
| F7 | `packages/mcp-server/test/dialects.test.ts:81` | 2 | `else if (field !== 'type')` excluded the OpenAI dialect's `type` discriminator from the required-field loop. Every tool could drop `"type": "function"` with no test failing. | **Fixed** — `type` now asserted as `'function'` explicitly (verified: all 7 tools carry it). |
| F8 | `plugins/claude-code/test/user-prompt-submit.test.ts:270` | 2 | `if (result.notice)` guarded both leak assertions in `never includes original secret value in notice`. A detector that stopped firing produces no notice, so the leak check disappears exactly when it matters. | **Fixed** — asserts `result.detected` and a truthy notice unconditionally, then the two leak checks. |
| F9 | `packages/core/test/dotenv.test.ts:67,76,84` | 2 | `if (line?.kind === 'assignment')` with no preceding assertion (line 38 in the same file does it correctly). If `parseDotenv` stopped classifying quoted / escaped-quote / `export` lines as assignments, three tests silently assert nothing. | **Fixed** — `expect(line?.kind).toBe('assignment')` added before each narrowing. |
| F10 | `packages/http-server/test/contract.test.ts:332–352` | 1 | `closes cleanly without hanging` contained **no assertion at all**. Only an outright throw or a vitest timeout could fail it, so a close that left the listener bound passed as success. | **Fixed** — asserts a post-close request to the same URL rejects, i.e. the port was genuinely released. |
| F11 | `packages/detector/test/metrics.test.ts:48,53` | 1 | `highConfidenceRecall` was computed and logged but never asserted. A regression demoting every registry-derived pattern from `high` to `low` confidence produced no failure. | **Fixed** — gated at `>= 0.9` (baseline 0.9583). |
| F12 | `packages/cli/test/host.test.ts:10` | 4 | `mkdtempSync(join(process.cwd(), 'test-host-'))` created the fixture project **inside the repo**, so host detection ran under a tree already carrying the repo's own `.claude/` and `AGENTS.md` markers — it could pass for the wrong reason — and the `afterEach` `rmSync` swallows failures, leaving directories in the source tree. | **Fixed** — `mkdtempSync(join(tmpdir(), …))`. |
| F13 | `packages/sdk/test/dispatch.test.ts:22` | 4 | `root: process.cwd()` pointed the broker at the repository. `env_declare` / `env_describe` dispatches could read and write `env.schema.jsonc`, `.env` and `.envseal/` into the source tree, and results depended on repo state. | **Fixed** — throwaway `mkdtempSync(tmpdir())` root with `afterEach` cleanup. |
| F14 | `packages/core/test/dotenv.test.ts:283` (property test oracle) | — | **Flaky test masking nothing — but corroding the one suite that guards `.env` integrity.** The oracle regex `/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/` does not account for the BOM the generator prepends, so on a BOM file it failed to locate the target assignment on line 0, marked it "must be unchanged", and failed on a **correct** surgical write. Reproduced at iteration 16 of a 25-run loop (`seed: -277847853`, counterexample `["﻿P_0=\"value with spaces\"", "P_0", "value'with'quotes"]`). | **Fixed** — oracle strips an optional leading BOM. **The implementation is correct** (`parseDotenv` strips the BOM at src:57–58, `serializeDotenv` re-emits it at src:136); confirmed by direct reproduction preserving BOM, CRLF and quoting. Post-fix: **0 failures in 40 consecutive runs.** |
| F15 | `plugins/claude-code/test/{pre-tool-use,user-prompt-submit}.test.ts` | 3 | Tests import `hooks/*.ts` while Claude Code executes `hooks/dist/*.cjs`. **Mitigated** — `test/bundle-integration.test.ts` spawns all three `.cjs` bundles, which closes the original 107-test defect. **Residual, proven:** `pnpm test` never rebuilds, so source↔bundle drift is undetected — with `.env` protection mutated *out of the source*, `bundle-integration` stayed 6/6 green. | **Not changed.** CI runs `pnpm build` before `pnpm test` (`.github/workflows/ci.yml:29–31`), which closes it — but **CI has never executed (U7/E6)**, so the mitigation is itself unverified. Severity **Low–Medium**. |
| F16 | `packages/mcp-server/test/tools.test.ts:2,23` | 3, 1 | Asserts tool metadata against `../src/tools/*`, and `toHaveLength(7)` restates a 7-element array literal written in the test. **Mitigated** — `zero-leak.test.ts` spawns the real `dist/bin.js` and asserts `tools/list` returns 7 tools over stdio JSON-RPC, so the artifact's registration is genuinely covered. | **Not changed** — justified: the end-to-end test covers the claim. |
| F17 | `packages/mcp-server/test/dialects.test.ts:46,97` | 4 | Resolves and regenerates `spec/sep-1/dialects/*.json` under `process.cwd()`, i.e. inside the repo. | **Not changed** — justified: these are committed spec artifacts and regeneration is the property under test. Idempotent by design; F5/F6 now make a failed regeneration loud. |
| F18 | `user-prompt-submit.test.ts:221,227,250`; `sdk/dispatch.test.ts:77`; `sdk/dialects.test.ts`; `mcp-server/tools.test.ts:38` | 1 | `toBeDefined()` on fields that are non-optional in the return type — these restate the type signature and cannot independently fail. | **Not changed** — low value, no security claim attached; `expect(labels[0]).toBeDefined()` at :250 is implied by the `length > 0` assertion two lines above. Recorded so they are not mistaken for coverage. The one member of this class that *did* carry a security claim (`errs toward redaction (fail-closed)`, :262) was **fixed** — see F19. |
| F19 | `plugins/claude-code/test/user-prompt-submit.test.ts:262` | 1 | A test named **`errs toward redaction (fail-closed)`** asserted only `expect(result.modifiedMessage).toBeDefined()` on a non-optional string. Total loss of fail-closed behaviour would not have failed it. | **Fixed** — now feeds a realistic high-entropy blob and asserts `detected === true`, that the blob is absent from the output, and that a redaction token is present. Passes, so the entropy fallback genuinely works. |

### Assertion patterns swept and found absent

`toBeGreaterThanOrEqual(0)`, `toBeGreaterThan(-1)`, `expect(true).toBe(true)`, `expect(1).toBe(1)`,
`toBeLessThanOrEqual(Infinity)` — **zero occurrences**. The exit-code contract called out in
VERIFICATION.md §0 is now asserted with exact equality in `packages/cli/test/exit-codes.test.ts`
(clean) and `shell-e2e.test.ts`. No `if (process.platform !== 'win32')` assertion-skip guards exist
in the audited files.

---

## 2. Mutation-check log

Each mutation was applied to the implementation, the suite run, and the mutation reverted.
"Caught by" names the test that actually failed.

| # | Subject | Mutation | Red? | Caught by |
|---|---|---|---|---|
| M1 | `protocol` | Removed `.strict()` from `ManifestEntry` (`src/schemas.ts:40`) | ✅ **3 failed** | `schemas.test.ts` → `rejects an injected value-shaped secret field (T3)`, `rejects unknown fields even when the object looks like a key`, `still rejects unknown fields on a full entry` |
| M2 | `core` (redaction) | `redact()` made a no-op returning `{ text, count: 0 }` | ✅ **14 failed** | `redact.test.ts` — all 4 property tests (`never leaks the raw secret` / `base64` / `URI-encoded` / `>= 20-char prefixes`), 8 unit tests, plus `exec.test.ts › redacts injected secrets from stdout` |
| M3 | `core` (`.env` integrity) | `setDotenvValue` made non-surgical (comments and blank lines dropped, file reflowed) | ✅ **2 failed** | `dotenv.test.ts › surgical edit maintains byte-for-byte line identity (fast-check, 300 runs)` and `updates existing key surgically` |
| M4 | `core` (broker sentinel) | `describe()` returns the raw value in the `fingerprint` field | ✅ **2 failed** | `broker.test.ts › describe never returns values` and `e2e flow: declare → describe → request → await → describe` |
| M5 | `detector` | Registry prefix threshold raised `{16,}` → `{64,}`, disabling every registry-derived pattern | ⚠️ **1 failed** | `patterns.test.ts › should detect sk- prefix key`. **The metrics gate did NOT fail** — see §3. |
| M6 | `prompters` | Loopback accepts any path nonce (`secureEqual` check removed) | ✅ **1 failed** | `loopback.test.ts › rejects a wrong path nonce with 404` |
| M7 | `mcp-server` (egress) | `env_describe` returns a hand-built `{ content: [...] }` instead of `respond()` | ✅ **1 failed** | `egress.test.ts › describe.ts returns only via respond()/respondError()` |
| M8 | `mcp-server` (zero-leak, end-to-end) | M4 re-applied in `core` **and `core` rebuilt**, so the leak reached the shipped `dist/bin.js` over real stdio JSON-RPC | ✅ **1 failed** | `zero-leak.test.ts › never emits the sentinel while completing the full provisioning flow` — failed on its `fp_[0-9a-f]{8}` flow-completion guard, the assertion its own header comment says exists so a broken run cannot pass silently |
| M9 | `cli` | `parseArgs` end-of-flags `--` handling removed | ✅ **2 failed** | `parse-args.test.ts › treats -- as a terminator, not a flag` and `keeps flag-shaped arguments after -- intact` |
| M10 | `plugins/claude-code` | `isDeniedSecretPath` returns `false` for `.env` | ✅ **6 failed** | `pre-tool-use.test.ts › denies .env`, `handles backslash paths`, `denies Read/Edit/Write .env`, `denies cat .env`. **But the four `denial has alternative suggestion` tests stayed green** — F1. After the F1 fix, the same mutation yields **8 failed**. |
| M11 | `core` (bonus, validates F2) | `assertGitSafe()` made a no-op | ✅ **1 failed** *(only after the F2 fix)* | `dotenv.test.ts › throws SEP_GITIGNORE_UNSAFE when file is git-tracked`. Under the **pre-fix** test this mutation passed green. |
| M12 | `plugins/claude-code` (bonus, validates F15) | `.env` protection removed from **source only**, bundles left stale | ❌ **green** | Nothing. `bundle-integration.test.ts` passed 6/6 against the stale `.cjs`. Drift is invisible to `pnpm test`. |

**Score: 10 / 10 primary subjects (M1–M10) went red.** No headline claim is entirely untested.

---

## 3. Weakly-guarded claims

No claim is wholly untested, so nothing here is a **High** finding under §3 of the plan. Two claims
are guarded more loosely than their prominence suggests.

### 3.1 Detector metrics gate is insensitive to registry-pattern regression — **Medium**

`packages/detector/test/metrics.test.ts` is the detector's headline claim (recall ≥ 0.95,
false-positive rate ≤ 0.02). Under M5 — which disabled **every** registry-derived prefix pattern —
the gate still passed:

| | baseline | under M5 |
|---|---|---|
| recall | 1.0000 (48/48) | 0.9583 (46/48) — threshold 0.95, **passed** |
| high-confidence recall | 0.9583 (46/48) | 0.9167 (44/48) — **not asserted at all** |
| false-positive rate | 0.0000 (0/100) | 0.0000 (0/100) |

Destroying the registry patterns cost only 2 of 48 positives, because the positive fixture corpus
barely exercises them. The claim survived on margin, not on correctness; the mutation was caught by
a *unit* test (`patterns.test.ts`), not by the gate.

**Actions taken:** added the missing `highConfidenceRecall >= 0.9` gate (F11).
**Recommended (not done — corpus authoring is outside this workstream):** extend
`test/fixtures/positive.txt` with at least one line per registry-derived provider prefix, so recall
is coupled to the registry the detector actually ships.

### 3.2 Source↔bundle drift in the Claude Code plugin — **Low–Medium**

Proven by M12: `pnpm test` does not rebuild, so `hooks/*.ts` and `hooks/dist/*.cjs` can disagree
with a fully green suite. This is the mirror image of the original defect (source tests green,
bundles broken) rather than a recurrence of it — `bundle-integration.test.ts` does execute the real
artifacts. CI closes the gap by running `pnpm build` first (`.github/workflows/ci.yml:29–31`), but
CI has never run (U7), so the mitigation is unverified. **Recommended:** make the plugin's `test`
script depend on `build`, or add a freshness assertion comparing bundle mtime to source mtime.

### 3.3 U10 — resolved during this workstream by W2

`packages/http-server/test/contract.test.ts` previously declared a sentinel it never stored, making
its leak assertion true by construction. The working tree now provisions the value into the dotenv
sink before asserting, and asserts the fixture really is provisioned. **U10 can be closed.**

---

## 4. Final state

### Working tree

All 12 mutations reverted; `grep -rn "W4-MUTATION" packages plugins --include=*.ts` → **no matches**.
No file under any `src/` directory was modified by W4.

W4 modified **10 test files only**:

```
packages/cli/test/host.test.ts                     |   6 +-
packages/core/test/dotenv.test.ts                  |  37 ++--
packages/detector/test/metrics.test.ts             |   4 +
packages/http-server/test/contract.test.ts         |  (W4 portion: +13)
packages/mcp-server/test/dialects.test.ts          |  28 +--
packages/registry/test/examples.test.ts            |   6 +
packages/registry/test/safety.test.ts              |  25 ++
packages/sdk/test/dispatch.test.ts                 |  18 +-
plugins/claude-code/test/pre-tool-use.test.ts      |  21 +-
plugins/claude-code/test/user-prompt-submit.test.ts|  22 +-
```

> **Concurrency note.** W2, W3, W5–W7 were running in this same working tree. Changes to
> `packages/prompters/src/loopback.ts` (the `Origin`-must-match fix) and the bulk of
> `packages/http-server/test/contract.test.ts` (the U10 provisioning fix) belong to those
> workstreams, not to W4. W4's only edit to `contract.test.ts` is the post-close assertion in F10.

### `pnpm -r build && pnpm -r test`

See §5 for verbatim output.

## 5. Final `pnpm -r build && pnpm -r test` output

Run at the close of W4, after every mutation was reverted. Exit code 0.

```
$ pnpm -r build
... all 10 packages + plugins/claude-code: Done (tsc clean)

$ pnpm -r test
packages/registry test:  Test Files  4 passed (4)
packages/registry test:       Tests  15 passed (15)
packages/protocol test:  Test Files  4 passed (4)
packages/protocol test:       Tests  56 passed (56)
packages/detector test:  Test Files  5 passed (5)
packages/detector test:       Tests  40 passed (40)
packages/prompters test:  Test Files  5 passed (5)
packages/prompters test:       Tests  28 passed | 1 skipped (29)
packages/core test:  Test Files  13 passed (13)
packages/core test:       Tests  130 passed (130)
packages/sdk test:  Test Files  3 passed (3)
packages/sdk test:       Tests  11 passed (11)
plugins/claude-code test:  Test Files  4 passed (4)
plugins/claude-code test:       Tests  113 passed (113)
packages/mcp-server test:  Test Files  4 passed (4)
packages/mcp-server test:       Tests  22 passed (22)
packages/http-server test:  Test Files  1 passed (1)
packages/http-server test:       Tests  9 passed (9)
packages/cli test:  Test Files  4 passed (4)
packages/cli test:       Tests  19 passed (19)

TOTAL: 47 test files, 443 passed, 1 skipped, 0 failed. Exit code 0.
```

Baseline at the start of W4 was 439 passing. The delta is the `every provider file parses`
guard added by F3 plus tests added concurrently by other workstreams; no test was removed
or disabled by W4.

### Mutation residue check

```
$ grep -rn "W4-MUTATION" packages plugins --include=*.ts
(no matches)

$ git status --short -- "packages/*/src" "plugins/*/hooks"
(packages/prompters/src/loopback.ts belongs to W3, not W4 — see the concurrency note above)
```
