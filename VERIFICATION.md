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
- **E6** CI is green on a real run (runs [32644162967](https://github.com/NDilanka/envseal/actions/runs/32644162967), [32644732723](https://github.com/NDilanka/envseal/actions/runs/32644732723), and [32701031352](https://github.com/NDilanka/envseal/actions/runs/32701031352) on origin/main).
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
| U7 | ~~CI has never run — no remote exists~~ resolved: green runs 32644162967, 32644732723 | E6 |
| U8 | MCP server never connected to a real MCP client | M4 |
| U9 | ~~Only Windows tested; Linux/macOS unexercised~~ resolved: CI runs all three OS (see E1/E6) | W1 |
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
  Include at least one non-ASCII character (e.g. `é` or `🔐`) — the value crosses the pipe as
  hex of its UTF-8 bytes, so it must round-trip byte-exact (fixed 2026-08-23; previously
  non-ASCII mojibaked through the OEM-codepage pipe).
- **M3 — CLOSED (updated 2026-08-23): the sink stores AND resolves.** The original run
  (2026-08-21) proved only the write leg — DPAPI blob at
  `%LOCALAPPDATA%\envseal\creds\<KEY>` non-empty hex, decrypts back to the canary exactly,
  nothing reaches `.env` — and recorded read() as write-only. Commits 84cdc79 and b1acef7
  closed it: `scripts/probe-m3-keychain.mjs` now drives the full round-trip through the real
  Broker — store via `envseal set`, presence sink-aware (`status` reports the keychain entry
  present), `envseal run` injects the resolved value into the child, revoke truthful. The
  earlier documented limitation ("presence checks consult only env/`.env` so keychain keys
  report absent and ensure re-prompts") is fixed in code, not just docs.
- **M4 — artifact-level PASS; interactive remainder runbooked.** Two independent headless
  `claude -p --plugin-dir plugins/claude-code` sessions against a canary `.env` produced
  transcripts with **zero** occurrences of either sentinel (grep counts 0/0 both sessions);
  in the second session the child declined to route around a denial and re-secured the
  `.gitignore` it found missing the rule. The PreToolUse deny path itself is proven by
  `scripts/probe-m4-hook-contract.mjs` (18/18 over the real bundle), the plugin contract
  tests over built bundles, the W4 mutation check (disabling `isDeniedSecretPath` turns 8
  tests red), and a live in-session denial recorded during this verification (a `cat` of the
  dotenv file was refused by the hook inside the orchestrating session). Human-only
  remainder: watching `env_request` open a real interactive consent prompt (the page itself
  is verified separately under M1).
- **M5 — extension code exercised; in-editor load human-only.** Two layers:
  `packages/prompters/test/ide.test.ts` drives the wire protocol over a real named pipe
  (token auth, unauthenticated fast-fail, cancel framing); `scripts/probe-m5-extension-host.mjs`
  activates the BUILT `extensions/vscode/dist/extension.js` against a `vscode` API stub and
  drives it with the shipped IdePrompter — activation binds the pipe, the shared token is
  enforced, `showInputBox` receives password+nonce+reason, the typed value crosses back as a
  SecretValue, an empty answer maps to `skipped`, and after `deactivate()` nothing answers
  the pipe. **Runbook (human):** load `extensions/vscode` via Extension Development Host,
  trigger `envseal set`, confirm the input box renders and the value reaches the broker.

---

## 6. Sign-off

| Criterion | Status | Evidence |
|---|---|---|
| E1 clean-clone build, 3 OS | **PASS — all three OS, on CI.** | Windows locally: `git clone` to `%TEMP%\envseal-final-clone` → `pnpm install --frozen-lockfile` → build (serial; parallel build died on host `VirtualAlloc` exhaustion, not code) → typecheck → full suite green. Linux/macOS via CI runs [32644162967](https://github.com/NDilanka/envseal/actions/runs/32644162967) and [32644732723](https://github.com/NDilanka/envseal/actions/runs/32644732723) (ubuntu-latest/macos-latest/windows-latest × node 22/24: build, typecheck, full test suite, zero-leak, portability all green). CI's first exposures caught two real defects, both fixed and verified: the plugin's missing `@envseal/mcp-server` devDep broke clean-checkout build order (a139eea), and the sops POSIX fake's bash-only `${!#}` failed under dash (8d1f46a). |
| E2 zero-leak adversarial | **PASS on Windows, current build.** | W2 report + fixes (19ff9bb redact rewrite, 085d62a T3 guard) + re-run on the final tree: `probe-w2-oracle` (3094 tool calls recover only 256 literal dots, `EXACT MATCH: false`), `probe-w2-cli` (sentinel absent from manifest/audit/salt), `probe-w2-sdk` (all four free-text fields → `SEP_VALUE_IN_REQUEST`, no sentinel on disk), `probe-w2-http` (exit 0, sentinel absent everywhere incl. headers), `probe-b9-redact-limit` (4,000,000-byte values redacted from 1 MB haystack, ≤436 ms), mcp-server zero-leak suite drives `dist/bin.js` over real stdio (49 tests). |
| E3 no Critical/High open | **PASS** (independent cold audit concurred). | Six workstream reports + uncorrelated cold-context audit of `76ffcd4..HEAD`; every previously-open Critical/High re-verified fixed against built artifacts (audit's list: oracle, T3, redact bounds, consent wiring, exit codes, W7 degradation, publishing, hook contract, tier honesty). Audit's N1 (timeout reported as user denial) fixed in cab-… this push: `SEP_TICKET_EXPIRED` with explicit "not a denial" message, proven over raw stdio vs `dist/bin.js`. Known Lows from the final report are closed as of 2026-08-23: N4 (value zeroed on the sink-write-failure path, try/finally + regression test), N5 (`/openapi.json` now requires the bearer token, 401/200 pinned), W3-07 (printf/echo/sed/awk/grep/backtick/`$(<file)` env-dump shapes denied, benign printf still allowed). |
| E4 docs commands executed | **PASS for the CLI contract + host docs; per-host GUI installs UNVERIFIED.** | Cold audit executed `init/doctor/status/set/ensure/run/revoke --json` against `dist/bin.js` and matched `docs/cli-contract.md` field-for-field; host-doc snippets tested against the built binary during the B8 sweep (doctor outputs, status exit codes, guard branches). What remains human: installing MCP configs inside real Cursor/Zed/etc. GUIs. |
| E5 publish dry-run correct | **PASS — registry round-trip now PROVEN.** | `pnpm release:dry` → 9/9 tarballs "no workspace:, no maps", preflight passed; `scripts/probe-b1-tarball-install.mjs` → all 9 tarballs `npm install` from a bare dir, pinned export imports, both bins run from an unrelated cwd with no `.envseal/` scatter. **Real publish 2026-08-24:** Release run [32729332027](https://github.com/NDilanka/envseal/actions/runs/32729332027) (tag v0.1.0) published all 9 `@envseal/*` packages at 0.1.0; registry metadata shows tarball + registry signature for each; clean-dir smoke: `npm i @envseal/cli` → 108 packages, `envseal --version` → 0.1.0, init→gate(fail 1)→set(stored)→run with child output redacted (`redactedCount:1`). Getting there took four real-red fixes: the Linux-CI wget ghost artifact (gitignored + hermetic test URLs), detached-HEAD publish flags, and a preflight step that was reading setup-node's placeholder instead of the mapped secret. Provenance OIDC skipped on this first publish (trusted publishers attach to existing packages only); registry ECDSA signatures present — configure trusted publishing before v0.1.1. **v0.1.1 (same day, Release run [32733910110](https://github.com/NDilanka/envseal/actions/runs/32733910110)): provenance PROVEN end-to-end** — trusted publishers configured on all 9 packages (NDilanka/envseal + release.yml), all 9 published at 0.1.1 with `dist.attestations` carrying SLSA `https://slsa.dev/provenance/v1` + npm publish attestation; the first v0.1.1 attempt's 422 ("repository.url is empty, expected to match github.com/NDilanka/envseal") proved the verification is real and produced the repository/homepage/bugs manifest fix (e1bacfd). Clean-dir smoke: `npm i @envseal/cli@0.1.1` → `envseal version 0.1.1`. |
| E6 CI green on real run | **PASS.** | Runs [32644162967](https://github.com/NDilanka/envseal/actions/runs/32644162967), [32644732723](https://github.com/NDilanka/envseal/actions/runs/32644732723), and [32647165033](https://github.com/NDilanka/envseal/actions/runs/32647165033) (the full current matrix incl. the example-demo job) green: build lint portability zero-leak + 3-OS × node 22/24 build/test. Getting there took four fixes, each from a real red run: node-20 matrix legs (a139eea — pinned pnpm needs node:sqlite ≥ 22.13), the dash/bashism sops fake (8d1f46a), cold-runner powershell test timeouts (a3b8285), and the demo job's dependency-less CLI build (29ad956). One macOS-24 env-use failure in run 32646843552 did not reproduce on identical code in 32647165033 — recorded as a runner flake, watched for, not silently ignored. Newest: [32701031352](https://github.com/NDilanka/envseal/actions/runs/32701031352) green on dc2c76d — the W3 closure commit (rg/bat/nl reader gap, empty-Origin 400, unknown-op 404), full matrix again. |
| E7 manual gates M1–M5 | **M1 PASS (twice). M4 artifact-level PASS (two sessions, zero canary hits). M2/M3/M5 mechanism-verified; human remainders runbooked.** | M1: prior real-Chrome run + `probe-m1-browser-bridge.mjs` through the kimi web bridge — real Chrome rendered the page, displayed nonce matched, canary round-tripped byte-exact, port refused after. M2: `probe-m2-native` fail-closed paths; typed masked entry runbooked. M3: `probe-m3-keychain` DPAPI round-trip; resolution impossible by design (documented). M4: two headless plugin sessions → 0/0 sentinel grep both transcripts; deny path proven by hook-contract probe 18/18, contract tests, W4 mutation, and a live in-session denial; interactive `env_request` observation runbooked. M5: built extension.js activated under a stub host and driven by the shipped IdePrompter end to end (`probe-m5-extension-host.mjs`) + wire tests; in-editor load runbooked. |
| E8 residual risks accurate | **PASS.** | Seven risks each match implementation on cold re-read (write-only keychain + presence blindness, HTTP loopback, string-conversion points, staged-temp fallback, double-gated test hooks, env_use user-confirmed egress). SECURITY.md count corrected to seven; PLAN §7.2 annotated (Windows DPAPI files, not Credential Manager). |
| **E9** W4 adversarial battle-test (2026-08-25) | **PASS — 0 Critical open; 4 findings fixed and shipped in v0.1.2; 2 reclassified as correct behavior.** | ~55 scenarios across 9 phases against published v0.1.1 artifacts (`docs/verification/W4-battle-test.md`, probes in `.commandcode/probe-w4-p*.mjs`). Redaction engine unbeaten: raw/stderr/multi-secret/10MB-volume all redacted, audit never holds values, MCP server survived malformed frames + floods with zero failures, plugin deny matrix held incl. traversal paths, host-detection precedence held under fake-HOME. Fixed in v0.1.2 (23bedc0): **F2 High** ensure/set hang forever non-TTY → fail closed exit 4 in ~300ms; **F5 Med** detector missed sk-live-/bare-sk- OpenAI shapes → patterns added; **F1 Med** init laundered hostile pre-existing manifests → guard scan on read path; **F4 Low** missing-manifest run now warns on stderr. F6 (audit recreation) proven correct behavior; F3 (keychain sink) proven probe artifact — set honors declared sink end-to-end. Registry proof: v0.1.2 published with SLSA v1 provenance ([release run](https://github.com/NDilanka/envseal/actions/runs/32756572088)), clean-dir smoke green. Known documented boundaries: grandchild-process stdout not intercepted (broker-spawned direct stdio only); transformed encodings inside child output are out of literal-match scope by design. |


Launch is authorised only when every row is filled with recorded evidence.
