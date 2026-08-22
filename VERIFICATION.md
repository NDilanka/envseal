# envseal — Launch Verification Plan

**Purpose:** establish, with evidence, that this repository is safe to publish.
**Status:** in progress
**Rule for every workstream:** a claim is verified only when a command was run and its
output recorded. "Tests pass" is not evidence that the thing works — this build shipped an
MCP server that typechecked cleanly and could not start, an SDK with 11 green tests where
six of seven tools returned "Tool not available", and three hook bundles that crashed on
load while 107 source-level tests passed. **Exercise the artifact, not the code.**

---

## 0. Why this plan is shaped this way

Every defect found while building this repo shared one property: the test suite was green
and the deliverable was broken. The recurring mechanisms were:

| Mechanism | Example from this build |
|---|---|
| Test imports source, never runs the artifact | 107 hook tests passed; all three bundles crashed with `MODULE_NOT_FOUND` |
| Assertion wrapped in `if (x)` | `if (ticket)` hid an SDK where 6/7 tools were dead |
| Assertion that cannot fail | `expect(exitCode).toBeGreaterThanOrEqual(0)` guarding the exit-code contract |
| Cast silencing an API mismatch | `as never` on `setRequestHandler` → server could not start |
| Wrong-but-plausible lookup | `getProvider(envVar)` where ids are `openai` → registry enrichment silently inert |
| Test mutates the repo under test | fixtures under `process.cwd()` wrote a manifest into the source tree |

The workstreams below are therefore weighted toward **adversarial execution** and **audit of
the tests themselves**, not toward re-running a suite that already passes.

---

## 1. Launch exit criteria

Publication is blocked until all of these hold:

- **E1** Fresh clone → `pnpm install && pnpm build && pnpm test` green on Linux, macOS, Windows.
- **E2** Zero-leak holds under adversarial attempt, not just the happy path (W2).
- **E3** No **Critical** or **High** finding open (see §3 severity).
- **E4** Every install/usage command in README, docs/, and per-host guides has been executed
  verbatim and produced the documented result, or is explicitly marked unverified.
- **E5** `npm publish --dry-run` yields correct file lists, `bin` entries, and `exports` for
  every published package; nothing private leaks into the tarball.
- **E6** CI is green on a real run (it has never executed — there is no remote yet).
- **E7** Manual gates M1–M5 (§5) each have a recorded human result.
- **E8** Residual-risk doc matches what the code actually does — no guarantee is claimed that
  the implementation does not deliver.

---

## 2. Workstreams

Each workstream names an owner rung, a method, and an acceptance test. Rung choice follows
the repo rule: code-touching work never drops below Opus; bulk read-to-small-conclusion goes
to DeepSeek; one divergent lane goes to Fable for uncorrelated failure modes.

### W1 — Build, install and publish integrity · `opus-high`
Fresh-clone reproducibility and package correctness.
- Clone to a clean directory (not the working tree). `pnpm install --frozen-lockfile`, `build`, `typecheck`, `test`.
- `npm pack --dry-run` per publishable package: confirm `files`, `exports`, `types`, `bin`,
  and that `src/`, tests, and `.envseal/` are absent from the tarball.
- Confirm every `workspace:*` dep would resolve to a published version.
- Confirm `bin` entries are executable and resolve after a simulated global install.
- **Accept:** clean-clone green; every tarball manifest recorded; no private/test file shipped.

### W2 — Zero-leak adversarial · `opus-xhigh`
Actively try to make a secret escape. This is the product's central claim.
- Attempt leakage through every egress: tool results, error paths, audit log, statusline
  cache, manifest, `.envseal/*`, stderr, exec output, verify probe messages, HTTP bodies.
- Force error branches: invalid format, sink write failure, probe 500, prompter throw,
  malformed JSON-RPC, oversized body, unicode/multi-byte values, values containing
  `«redacted»` literally, values that are substrings of other values.
- Re-run the sentinel sweep across **all four bindings** (MCP, SDK, HTTP, CLI).
- **Accept:** a written list of attempted escapes, each with the observed result. Any escape
  is Critical.

### W3 — Security red-team of the network and prompt surfaces · `opus-xhigh`
- Loopback prompter: DNS-rebinding, `Origin`/`Host` variants, path-nonce brute force, CSRF
  replay, second-use after close, keep-alive socket survival, body-size cap, CSP correctness,
  HTML injection through `reason`/`description`/provider fields.
- HTTP server: token comparison timing, missing/short token, `Host` spoof, non-loopback bind,
  method confusion, path traversal on `/v1/*`.
- Probe path: allowlist bypass via redirect, IDN/punycode host, userinfo-in-URL, `{{value}}`
  smuggled into a header name rather than a value.
- Threat-model rows T1–T14: for each, attempt the attack and record the outcome.
- **Accept:** every T-row has a recorded attempt and result; deviations filed by severity.

### W4 — Test-suite quality audit · `opus-high`
Audit the tests, not the code. This is where every prior defect hid.
- Find every assertion that cannot fail: `toBeGreaterThanOrEqual(0)`, `toBeDefined()` on a
  literal, `expect(true)`, empty `expect.any`.
- Find every conditional assertion (`if (...) { expect... }`) and judge whether it hides a
  regression; unconditionalise or justify each.
- Find every test that imports source where a built artifact exists (bundles, bins, servers).
- Find tests whose project root is the repo rather than a temp dir.
- Confirm each package's headline claim has a test that would actually fail if broken —
  deliberately break it, observe red, revert.
- **Accept:** a table of findings with file:line, and a mutation-check log showing each
  headline test genuinely fails when its subject is broken.

### W5 — Docs ↔ implementation accuracy · `deepseek-delegate`
Bulk read, small conclusion. Read-only.
- Extract every command, flag, file path, env var, tool name, error code and exit code
  mentioned in `README.md`, `SECURITY.md`, `docs/**`, `spec/sep-1/SPEC.md`, `PLAN.md`.
- Check each against the source. Produce a table: claim → file cited → exists? → matches?
- Flag anything the docs promise that the code does not do.
- **Accept:** a complete claim table; every mismatch listed with a proposed correction.

### W6 — Host integration matrix reality check · `deepseek-delegate`
Read-only.
- For each of the 13 `docs/hosts/*.md`: does the snippet reference the correct binary name
  (`envseal-mcp`), correct args, correct package name? Is the protection tier consistent with
  `packages/cli/src/host.ts`? Is `[VERIFY]` present wherever the path is genuinely uncertain?
- Cross-check `docs/hosts/README.md` matrix against the individual files for contradictions.
- **Accept:** a per-host table of internal-consistency results.

### W7 — Degradation and failure-mode testing · `opus-high`
The system must fail safe, never silently.
- `CI=1` (no interactive surface) → `SEP_NO_INTERACTIVE_SURFACE`, never a hang.
- No git repo; git repo with `.env` tracked; `.gitignore` absent; read-only filesystem;
  `.env` locked by another process (Windows); missing `.envseal/`; corrupt `salt`;
  corrupt/truncated manifest; manifest with unknown fields; disk full simulation.
- Concurrent access: two brokers on one project; ticket TTL expiry; process killed mid-write
  (assert `.env` is never left truncated — this is what atomic write exists for).
- Prompter selection under each platform/env combination.
- **Accept:** each scenario has a recorded exit code and message; no hang, no truncation,
  no silent success.

### W8 — Blind-spot pass · `fable-low`
A deliberately uncorrelated lane. Do not re-run the above.
- Read the repo cold and answer: what would a first-time user hit in the first ten minutes
  that nobody here has considered? What does the README imply that the code does not do?
  Where would a hostile reviewer on Hacker News attack this design first?
- Specifically probe the gap between what the threat model claims and what a naive user will
  believe after reading the README.
- **Accept:** a ranked list of blind spots with reasoning, no code changes.

---

## 3. Severity classification

| Severity | Definition | Launch impact |
|---|---|---|
| **Critical** | A secret can reach a transcript, log, or network destination it should not | Blocks launch |
| **High** | A documented guarantee does not hold; a primary command is broken; data loss (`.env` corruption) | Blocks launch |
| **Medium** | A feature is broken but has a workaround; a doc claim is wrong | Fix or document before launch |
| **Low** | Cosmetic, lint, wording | Post-launch |

Every finding must carry: severity, file:line, a concrete reproduction, and the observed vs
expected behaviour.

---

## 4. Known-unverified inventory (carried in from the build)

These are already known to be unexercised. They are inputs to the workstreams above, not
discoveries.

| # | Item | Owner |
|---|---|---|
| U1 | Loopback page never rendered in a real browser by a human | M1 |
| U2 | Windows PowerShell native dialog never opened | M2 |
| U3 | `keychain` sink reports available; never wrote a credential | W7 + M3 |
| U4 | `tty` prompter never exercised with a real terminal | W7 |
| U5 | Claude Code plugin never loaded in a live session (PLAN T8.4) | M4 |
| U6 | VS Code extension never loaded in VS Code | M5 |
| U7 | CI has never run — no remote exists | E6 |
| U8 | MCP server never connected to a real MCP client | M4 |
| U9 | Only Windows tested; Linux/macOS unexercised | W1 |
| U10 | `http-server` leak test never stores a secret, so it asserts nothing | W2 |

---

## 5. Manual gates (require a human — cannot be delegated)

| Gate | What to do | Pass condition |
|---|---|---|
| **M1** | Run `envseal set OPENAI_API_KEY`, let the real browser open, check the displayed nonce matches the terminal, type a value, submit | Value stored; page closes; port refuses a second connection; nonce matched |
| **M2** | Set `SEP_PREFER_NATIVE=1` on Windows and macOS, run `envseal set` | Masked dialog appears; cancel yields `cancelled`, not a crash |
| **M3** | Set a key with `sink: keychain`, confirm it appears in the OS credential store and `envseal run` resolves it | Value retrievable; `.env` holds only a reference |
| **M4** | Install the plugin in a live Claude Code session; ask the model to read `.env`; ask it to set up a missing key | Read is denied with an instructive message; `env_request` opens a real prompt; grep the session transcript for the value → zero hits |
| **M5** | Load the VS Code extension, trigger a request from the CLI | Input box appears with nonce and reason; value reaches the broker |

M4 is the highest-value gate: it is the only end-to-end test of the actual product experience,
and PLAN T8.4 requires grepping the on-disk session transcript for the sentinel.

### 5.1 Automation status per gate (2026-08-21)

What could be driven without a human at a console/browser was driven, against built artifacts;
what cannot be is listed as a runbook step, not claimed.

- **M1 — CLOSED** (prior session): loopback consent page loaded in real Chrome, canary
  round-tripped (`matchedSentinel: true`), listener refused connections afterward.
- **M2 — mechanism verified, typed entry human-only.** `scripts/probe-m2-native.mjs` verifies
  against `packages/prompters/dist`: (1) the real `NativePrompter` maps a closed stdin to
  `cancelled`; (2) the adapter's exact PowerShell template fails CLOSED under redirected stdin
  (empty output, promptly — `Read-Host -AsSecureString` reads the console input buffer, not a
  pipe, so no pipe harness can type into it); (3) full binary `envseal set` under
  `SEP_PREFER_NATIVE=1` resolves to `outcome=cancelled`, exit 3, writes nothing; (4) no temp
  `.ps1` left behind. **Runbook (human):** in a real interactive PowerShell console run
  `SEP_PREFER_NATIVE=1 envseal set <KEY>`; confirm the input is masked while typing, that
  Enter stores the value, and that Ctrl+C/empty Enter yields `cancelled` (exit 3), not a crash.
- **M3 — write leg verified live; resolution leg impossible by design.**
  `scripts/probe-m3-keychain.mjs` stores through the real Broker into a `sink: keychain`
  entry and asserts: DPAPI blob at `%LOCALAPPDATA%\envseal\creds\<KEY>` is non-empty hex,
  decrypts back to the canary exactly (DPAPI round-trip), nothing reaches `.env`, and
  `envseal run --` leaves the child without the value (`UNRESOLVED`). The gate AS WRITTEN
  ("value retrievable") cannot pass: the sink is write-only (`read()` returns null) — recorded
  as the documented limitation, not forced. Related honesty gap found by the probe and now
  documented in `docs/cli-contract.md` + `docs/residual-risks.md`: presence checks consult
  only env/`.env`, so keychain entries always report `present: false` and `ensure` re-prompts.
- **M4 — see §6 evidence row.** Automated artifact-level: headless `claude -p` session with
  `--plugin-dir plugins/claude-code` against a canary `.env`, transcript grepped for both
  sentinels; plus `scripts/probe-m4-hook-contract.mjs` (18/18) and the plugin contract tests
  over built bundles. Human-only remainder: watching `env_request` open a real consent prompt
  interactively.
- **M5 — wire contract verified, in-editor load human-only.** The broker↔extension socket
  protocol (shared `~/.envseal/ide-token`, one-JSON-line framing, unauthenticated fast-fail)
  is exercised over a real named pipe by `packages/prompters/test/ide.test.ts`. **Runbook
  (human):** `code --extensions-dir` / load `extensions/vscode` via Extension Development Host,
  trigger `envseal set`, confirm the password input box shows nonce + reason and the value
  reaches the broker.

---

## 6. Sign-off

| Criterion | Status | Evidence |
|---|---|---|
| E1 clean-clone build, 3 OS | **Windows: PASS. Linux/macOS: UNVERIFIED (no remote).** | `git clone` to `%TEMP%\envseal-final-clone` → `pnpm install --frozen-lockfile` → build (serial; parallel build died on host `VirtualAlloc` exhaustion, not code) → typecheck → full suite green: 591 tests + 3 portability, 0 failures; `git status --porcelain` empty after build. Linux/macOS evidence requires CI (see E6). |
| E2 zero-leak adversarial | **PASS on Windows, current build.** | W2 report + fixes (19ff9bb redact rewrite, 085d62a T3 guard) + re-run on the final tree: `probe-w2-oracle` (3094 tool calls recover only 256 literal dots, `EXACT MATCH: false`), `probe-w2-cli` (sentinel absent from manifest/audit/salt), `probe-w2-sdk` (all four free-text fields → `SEP_VALUE_IN_REQUEST`, no sentinel on disk), `probe-w2-http` (exit 0, sentinel absent everywhere incl. headers), `probe-b9-redact-limit` (4,000,000-byte values redacted from 1 MB haystack, ≤436 ms), mcp-server zero-leak suite drives `dist/bin.js` over real stdio (49 tests). |
| E3 no Critical/High open | **PASS** (independent cold audit concurred). | Six workstream reports + uncorrelated cold-context audit of `76ffcd4..HEAD`; every previously-open Critical/High re-verified fixed against built artifacts (audit's list: oracle, T3, redact bounds, consent wiring, exit codes, W7 degradation, publishing, hook contract, tier honesty). Audit's N1 (timeout reported as user denial) fixed in cab-… this push: `SEP_TICKET_EXPIRED` with explicit "not a denial" message, proven over raw stdio vs `dist/bin.js`. Known Lows (N4 un-zeroed value on sink-write failure path; N5 `/openapi.json` pre-auth) filed in the final report, none meets the High bar. |
| E4 docs commands executed | **PASS for the CLI contract + host docs; per-host GUI installs UNVERIFIED.** | Cold audit executed `init/doctor/status/set/ensure/run/revoke --json` against `dist/bin.js` and matched `docs/cli-contract.md` field-for-field; host-doc snippets tested against the built binary during the B8 sweep (doctor outputs, status exit codes, guard branches). What remains human: installing MCP configs inside real Cursor/Zed/etc. GUIs. |
| E5 publish dry-run correct | **PASS.** | `pnpm release:dry` → 9/9 tarballs "no workspace:, no maps", preflight passed; `scripts/probe-b1-tarball-install.mjs` → all 9 tarballs `npm install` from a bare dir, pinned export imports, both bins run from an unrelated cwd with no `.envseal/` scatter. Registry round-trip impossible pre-publish (no credentials) — recorded, not claimed. |
| E6 CI green on real run | **UNVERIFIED — no git remote exists.** | `.github/workflows/ci.yml` (3-OS matrix incl. zero-leak + portability jobs) has never executed. Local Windows equivalents of every job pass. Signing this row requires pushing to a remote and watching one green run. |
| E7 manual gates M1–M5 | **M1 PASS (twice). M2/M3/M5 mechanism-verified; typed-entry remainders runbooked. M4 artifact-level PASS; interactive remainder runbooked.** | M1: prior real-Chrome run + `scripts/probe-m1-browser-bridge.mjs` through the kimi web bridge — page rendered in the user's real Chrome, displayed nonce matched agent nonce, canary round-tripped byte-exact, port refused afterward. M2: `probe-m2-native` (fail-closed paths); typed masked entry = §5.1 runbook. M3: `probe-m3-keychain` (DPAPI blob non-empty, decrypts to canary, `.env` clean, run-leg `UNRESOLVED`); resolution impossible by design (write-only, documented). M4: headless `claude -p --plugin-dir` session — transcript grep 0 hits for both sentinels + `probe-m4-hook-contract` 18/18 + plugin contract tests over built bundles; forced-Read variant recorded in the final report. M5: wire contract over real named pipe (`ide.test.ts`); in-editor load = §5.1 runbook. |
| E8 residual risks accurate | **PASS.** | Seven risks each match implementation on cold re-read (write-only keychain + presence blindness, HTTP loopback, string-conversion points, staged-temp fallback, double-gated test hooks, env_use user-confirmed egress). SECURITY.md count corrected to seven; PLAN §7.2 annotated (Windows DPAPI files, not Credential Manager). |

Launch is authorised only when every row is filled with recorded evidence.
