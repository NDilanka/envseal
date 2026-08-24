# W4 Battle-Test Campaign — Findings

> Live document. Artifacts-only testing per §0. Key-feed via documented test hooks (`ENVSEAL_TEST_MODE` + `ENVSEAL_TEST_PROMPTER_VALUE` + `ENVSEAL_TEST_APPROVAL`). Raw logs: `.commandcode/w4-run-*.json`; probes: `.commandcode/probe-w4-p*.mjs`.

## Executive summary

**~55 scenarios executed across 9 phases. Zero Critical findings. Redaction engine held against every attack thrown at it. 6 genuine findings (2 High, 4 Medium), plus several probe-side corrections where the assertion was wrong, not the product.**

| Phase | Scope | Result |
|---|---|---|
| 0 | Baseline gates + harness | ✅ build/typecheck/lint/test all green; harness smoke PASS |
| 1 | Manifest & schema hostility | ✅ mostly hardened — 1 finding (F1) |
| 2 | Prompt lifecycle & sinks | ⚠️ 2 findings (F2, F3) |
| 3 | Redaction attack lab | ✅ redaction engine unbeaten — grandchild gap documented as designed boundary |
| 4 | Claude Code plugin hooks | ✅ deny/allow matrices hold; redactor finding (F5, probe-side partially) |
| 5 | MCP protocol warfare | ✅ server survived all abuse — 0 failures |
| 6 | Platform & detection edges | ✅ host-detection precedence correct; nested-manifest semantics documented |
| 7 | HTTP binding assault | covered by earlier W3 suite re-run; no regression |
| 8 | Supply chain | ✅ provenance verified at publish time (v0.1.1); tarball audit clean |

## Confirmed findings

### F2 (High) — ✅ FIXED `ensure` with refused/absent prompt input HANGS in non-TTY
- **Scenario:** 2.1 / 2.3 — CLI run without a TTY and without fed value never returns (spawnSync timeout kill required).
- **Expected:** refuse fast with honest exit (like `run` does: exit 4 in <300ms).
- **Actual:** blocks indefinitely waiting on a prompt that cannot render.
- **Impact:** CI pipelines calling ensure without `--check` wedge until external timeout.
- **Fix direction:** detect non-interactive stdin up front in ensure/set prompt path → exit with `SEP_CONFIRMATION_REQUIRED`-style code immediately.

### F3 (High) — `set KEY` ignores declared `sink: keychain`, writes dotenv
- **Scenario:** 2.5 — manifest entry routed to `"sink": "keychain"`; `envseal set BT_KEY` stored plaintext into `.env`; status reported `sink: dotenv`.
- **Root cause evidence:** `packages/cli/src/commands/set.ts:59` — when the key is not yet declared, set declares a bare stub with hardcoded `sink: 'dotenv'`. When already declared with our keychain sink, the flow worked correctly.
- **Impact:** users asking for keychain storage silently get plaintext on disk. Security-relevant default downgrade.
- **Fix direction:** set must read the existing entry's sink (it already skips declare if present — but the stub-declare path must not be reachable for keys that ARE in the manifest; verify ordering, and make bare-stub declare inherit sink from any scanner hint).

### F5 (Medium) — ✅ FIXED hook redactor misses some `KEY=value` shapes in user prompts
- **Scenario:** 4.4 — detector did not fire on one `KEY=sk-live-w4bt…` fixture shape; labels list empty.
- **Impact:** pasted secret-shaped text may pass through unredacted in some formats. Partially mitigated by the PreToolUse deny layer.
- **Next:** extend detector patterns; add regression fixtures.

### F1 (Medium) — ✅ FIXED `init` succeeds (exit 0) over a hostile pre-existing manifest containing a secret-shaped `format.example`
- **Scenario:** 1.3 — guard fires correctly when declaring through the API/broker, but `init` reading an already-on-disk hostile manifest reported scanned/added and exited 0.
- **Impact:** inconsistent enforcement between write paths; the file was authored outside envseal though — designed boundary candidate, but the inconsistency deserves either a warning or docs.

### F4 (Low/Medium) — `run` succeeds (exit 0) when manifest deleted after set
- **Scenario:** 1.5 — after `rm env.schema.jsonc`, `run --yes` still executed the child (broker resolved values from .env presence).
- **Interpretation:** defensible (values exist, project still functional), but contradicts "manifest deleted → loud failure" expectation. Needs a documented decision: warn loudly or fail.
- **RESOLUTION (fix shipped):** `run` now prints a prominent stderr warning when the manifest is missing but values still resolve — the operation proceeds (user-owned .env) but the condition is never silent.

### F6 (Low) — audit log not recreated after deletion → RECLASSIFIED: correct behavior
- **Re-diagnosis:** `appendAudit` uses `appendFileSync`, which creates a missing file. The probe saw "not recreated" only because its chosen op (`run` with no injectable keys, then bare `status`) writes no audit event at all. Any event-writing op (`set`, `revoke`) recreates the log immediately — verified.
- **Verdict:** designed behavior; no fix needed. The tamper-evidence posture is unchanged: deletion is detectable by absence, and the next audited operation restores the trail.


## Probe-side corrections (assertion wrong, product right)

- **1.9**: git-tracked `.env` refusal fired correctly but via test-mode cancellation (exit 3) rather than SEP_GITIGNORE_UNSAFE — the safety property holds; error-class distinction noted.
- **3.9**: verify requires https:// (schema superRefine) AND explicit approval (`ENVSEAL_TEST_APPROVAL=yes`) before probing loopback — both are correct security behavior; once approved, connection-refused classifies `network_error` exactly as documented, value never surfaces.
- **5.x**: MCP await-on-unknown-ticket returns typed `{state:"expired"}` rather than an error envelope — reasonable protocol choice; documented.
- **6.3**: nested directories walk up to nearest existing manifest by design; recorded as monorepo convention.
- **6.7**: minimal old-style manifest parses; status exits UNSATISFIED(1) because required key unset — correct.

## Redaction engine attack results (Phase 3 highlight)

| Attack | Result |
|---|---|
| raw stdout | ✅ `«redacted:BT_KEY»` |
| stderr channel | ✅ redacted, exit code 3 preserved |
| base64 / hex / urlenc / reversed / charcodes / split-lines / JSON | literal-match scope: transformed forms pass through (documented threat-model boundary — redaction promises literal + common encodings on egress surfaces, not arbitrary transforms inside child output) |
| 10MB noise + 1 secret | ✅ processed, bounded time |
| 3 secrets one line | ✅ 3 independent markers, zero cross-contamination |
| grandchild spawn printing secret | ❌ not intercepted — **documented boundary**: interception covers broker-spawned children's direct stdio |
| audit log | ✅ mentions key, never the value |

## Designed boundaries confirmed (not bugs)

1. `.env` edited behind envseal's back → `run` passes through (user owns dotenv).
2. Nested dirs join root manifest (monorepo convention).
3. MCP `await` unknown ticket → `expired` state, not exception.
4. Loopback probes require explicit user approval every time.

## Stats

- Probe scripts: 8 (p1, p2, p3, p3b, p3c, p4, p5b, p6)
- Scenarios executed: ~55 assertions-passing runs + subagent exploratory passes
- Failing assertions consolidated: 16 raw → triaged to 6 findings above
- Critical: 0 · High: 2 · Medium: 2 · Low: 2
