# W6 — Host integration matrix reality check

> **Historical.** This audit describes the tree *before* v0.1.5 host wiring.
> As of v0.1.5, `envseal init` writes project MCP/`AGENTS.md` for every matching
> marker (or `--host`); `detectHost()` knows the project-local markers listed in
> `docs/hosts/README.md`; `init --host` no longer hardcodes protection tier C;
> plugin snippets launch via `npx -y @envseal/mcp-server`. Do not treat the
> INCONSISTENT rows below as current defects. Leave the original findings intact
> as a record of what the earlier docs claimed.

Scope: documentation-consistency audit only; no live host integration, no file modified except this
report. Sources of truth: `packages/cli/src/host.ts` (tier assignments), `packages/mcp-server/package.json`
(`bin` = `envseal-mcp`), `packages/cli/package.json` (`bin` = `envseal`), `docs/cli-contract.md` (CLI
surface). All 13 per-host docs, `docs/hosts/README.md`, `README.md`, `docs/cli-contract.md`, both
`package.json` files, `host.ts`, and the four plugin files were read.

## 1. Matrix

`tier per host.ts` = whatever `detectHost()` returns for that host's documented setup. For hosts
`host.ts` does not know, `detectHost()` falls through to `unknown` (Tier C) — or to `generic` (Tier B)
when the project root contains `AGENTS.md`. "Bin correct?" = the MCP/CLI binary named in the doc exists
in a `package.json` `bin` field ("envseal-mcp" for @envseal/mcp-server, "envseal" for @envseal/cli) and the
commands/flags exist in `docs/cli-contract.md`.

| Host | Doc file | Binding tier claimed | Protection tier claimed | Tier per host.ts | Binary name correct? | Keychain recommended (if B/C)? | [VERIFY] present? | Result |
|---|---|---|---|---|---|---|---|---|
| claude-code | docs/hosts/claude-code.md | 1 (MCP) + hooks | A | A | yes | n/a (A; keychain still advised) | no | OK |
| cursor | docs/hosts/cursor.md | 1 (MCP) | B | B | yes | yes | no | OK |
| continue | docs/hosts/continue.md | 1 (MCP) | B | B (only if a project-root `.continue/` dir exists) | yes | yes | yes | INCONSISTENT — doc prescribes global `~/.continue/config.yaml` yet asserts doctor reports "Continue (Tier B)"; host.ts detects Continue only via a project `.continue/` dir, so the documented setup typically yields `unknown`/C |
| windsurf | docs/hosts/windsurf.md | 1 (MCP) | B | C (unknown fallthrough) | yes | yes | yes | INCONSISTENT — host.ts cannot detect windsuf; doctor reports `unknown`/C, not B (doc does acknowledge "Host: unknown") |
| cline | docs/hosts/cline.md | 1 (MCP) | B | C (unknown fallthrough) | yes | yes | yes | INCONSISTENT — host.ts cannot detect cline; doctor reports `unknown`/C, not B (doc only says "see which tier your setup provides") |
| zed | docs/hosts/zed.md | 1 (MCP) | B | C (unknown fallthrough) | yes | yes | yes | INCONSISTENT — host.ts cannot detect zed; doctor reports `unknown`/C, not B (no acknowledgment) |
| codex | docs/hosts/codex.md | 1 (MCP) | B | C (unknown fallthrough) | yes | yes | yes | INCONSISTENT — host.ts cannot detect codex; doctor reports `unknown`/C, not B (no acknowledgment) |
| goose | docs/hosts/goose.md | 1 (MCP) | C | C (unknown fallthrough) | yes | yes | yes | OK — tier matches by fallthrough; doc does not claim detection |
| copilot-agent | docs/hosts/copilot-agent.md | 1 (MCP) | B | B (generic, only because the doc mandates `AGENTS.md`) | yes | yes | yes | OK — tier B matches, but doctor reports "Generic Agent", not Copilot (host.ts has no copilot branch) |
| jetbrains | docs/hosts/jetbrains.md | 1 (MCP) | B | C (unknown fallthrough) | yes | yes | yes | INCONSISTENT — host.ts cannot detect jetbrains; doctor reports `unknown`/C, not B (no acknowledgment) |
| aider | docs/hosts/aider.md | 4 (CLI) | C | C | yes | yes | no | OK |
| openhands | docs/hosts/openhands.md | 4 (CLI) | C | B (generic, via the doc-mandated `AGENTS.md`) | yes | yes | yes | INCONSISTENT — the documented setup (AGENTS.md present) is detected as Tier B "Generic Agent"; doc claims C and does not acknowledge |
| shell-agent | docs/hosts/shell-agent.md | 4 (CLI) | C | B (generic, via the doc-mandated `AGENTS.md`) | yes | yes | no | INCONSISTENT — the documented setup (AGENTS.md present) is detected as Tier B "Generic Agent"; doc claims C and does not acknowledge |

Same-tier-by-fallthrough nuance: goose, windsurf, cline, zed, codex, jetbrains, openhands, shell-agent
cannot be reported under their own host id — `envseal doctor` will show `Host: unknown` (or, for the
AGENTS.md-based pair, `Host: Generic Agent`), never the documented host name.

Keychain requirement: every host documented as B or C recommends the `keychain` sink (verified in all
13 docs; claude-code being A also mentions it). No violation of the honesty rule.

Binary/CLI drift: every MCP snippet names `envseal-mcp` (exists in `@envseal/mcp-server` bins) and
every CLI snippet uses `envseal` (exists in `@envseal/cli` bins) with commands that exist in
`docs/cli-contract.md` (`status`, `ensure`, `set`, `run --`, `verify`, `doctor`, `init --host`). No
invented binaries or flags. Plugin files (`plugins/cursor/mcp.json`, `plugins/continue/config.yaml`,
`plugins/aider/.aider.conf.yml`, `plugins/generic/AGENTS.md`) are byte-consistent with their matching
host docs. No plugin/doc drift.

## 2. Inconsistencies found (ordered by seriousness)

1. **shell-agent.md and openhands.md claim Tier C, but the setup they document is detected as Tier B.** Both
   mandate `plugins/generic/AGENTS.md` at the project root, which `host.ts:83-91` maps to `generic / Tier B`
   ("protocol + advisory guardrails"). A user following either doc then runs `envseal doctor` and is told
   B while the doc and the matrix say C. host.ts's own taxonomy (AGENTS.md ⇒ B) contradicts the docs' C
   claim. *Fix: relabel openhands/shell-agent rows to B ("generic"), or add a C-agnostic AGENTS.md path to host.ts, or state the divergence in the docs.*
2. **Five docs/matrix rows claim Tier B for hosts host.ts cannot detect (windsurf, cline, zed, codex, jetbrains).**
   `detectHost()` has no branch for any of them, so `doctor` reports `unknown`/C — the claimed protection
   tier is never produced by the tool. Only windsurf.md acknowledges this ("it should report `Host:
   unknown`"); cline.md gestures at it ("see which tier your setup actually provides"); zed.md, codex.md
   and jetbrains.md give no acknowledgment and would surprise a user whose `doctor` says Tier C.
   *Fix: add one uniform "host.ts falls through to unknown/C; verify your tier with doctor" note to each
   of the five docs, or add detection for these hosts.*
3. **README.md architecture diagram implies hooks exist on Codex/Cursor/Zed/Cline.** README.md:29-30 draws a
   single HARNESS box listing "Claude Code / Codex / Cursor / Zed / Cline" and attaches "+ hooks:
   PreToolUse guard · UserPromptSubmit redactor · statusline" to that whole box. Only Claude Code has
   interception hooks (host.ts Tier A; all others B/C with advisory-only). This contradicts the same
   README's protection-tier section and the rule "only Claude Code has interception hooks".
   *Fix: scope the hooks line to Claude Code or move the harness list to a single host.*
4. **continue.md over-asserts doctor output.** `envseal doctor` "should report `Host: Continue (Tier B)`"
   (continue.md:25-26), but host.ts:51 detects Continue via a project-root `.continue/` directory while
   the doc's only documented config path is global `~/.continue/config.yaml` (plus a `config.json` note).
   `host.ts` "knows about" continue, so the tier B value is right, but the detection marker is not produced
   by the documented install. *Fix: tell users a project `.continue/` dir is needed for auto-detection, or
   drop/soften the "should report" guarantee.*
5. **claude-code.md's Tier-A guidance rests on environment detection, not the documented install.** `host.ts:27`
   grants Tier A only on a project-root `.claude/` dir or the `CLAUDECODE` env var (set for any process
   spawned inside a Claude Code session, per W8). The doc's recommended path installs to
   `.claude-plugin/plugin.json`, which host.ts does not check, so the "doctor should report Claude Code
   (Tier A)" promise holds only while running inside a Claude Code session. Related: `init --host
   claude-code` prints "(protection tier C)" because `init.ts:23` hardcodes tier C for any `--host`
   override — the same doc recommends that command. *Fix: align detection with `.claude-plugin/` and have
   `--host` carry the host's real tier.*
6. **shell-agent.md:22 mis-states `ensure` exit codes.** It lists "exit 1 / 3 / 4 / 5 / 6" for
   `envseal ensure`, but cli-contract.md documents ensure as exiting 0/1/3/4 only (5 = SINK_FAILURE and
   6 = VERIFY_FAILED belong to the global table / `verify`). *Fix: cite the contract's ensure-specific
   codes (0/1/3/4).*
7. **shell-agent.md:28 sample guard never matches the documented JSON.** `grep -q '"present": true, "key":
   "OPENAI_API_KEY"'` cannot match cli-contract.md's `status --json` schema, where `key` comes before
   `present`, nested under `entries[]`, and the two never appear adjacent. The illustrated pre-command
   guard therefore always fails (always "not provisioned") even when the key is present.
   *Fix: rewrite the guard against the real shape (e.g. `node -e`/`jq` over `entries`).*
8. **README "Works with any agent" host list is not mapped by the matrix (info).** README.md:94 names Roo,
   Amp, Kilo, OpenAI Agents SDK, LangGraph/CrewAI as Tier-1 MCP hosts with no per-host doc or matrix row.
   Not a contradiction — the README's tier table and docs/hosts/README.md agree on every host they both
   cover — but the matrix is not a complete map of the README's list. *Fix: add rows or annotate the
   README list as "capability claim; not all hosts have per-host docs".*
9. **claude-code.md:9 calls the plugin "bundled" (info).** Nothing is shipped yet (README says "not yet
   published to npm"), so "the bundled plugin" overstates distribution. *Fix: say "the plugin in this
   repo".*

## 3. Detectable vs documented-but-undetectable hosts

`packages/cli/src/host.ts` can actually detect, by marker, exactly four hosts (plus two synthetic states):

- **Detectable as themselves:** `claude-code` (Tier A — `.claude/` dir or `CLAUDECODE` env var),
  `cursor` (Tier B — `.cursor/` dir or `CURSOR_*`), `continue` (Tier B — `.continue/` dir), `aider`
  (Tier C — `aider.conf.*` / `.aider.conf.*`).
- **Detectable synthetically:** any project with `AGENTS.md` is reported as `generic` (Tier B), and
  anything else as `unknown` (Tier C).

**Documented but undetectable as themselves** (host.ts has no branch for their host id; they fall to
`unknown`/C — or to `generic`/B when their doc adds `AGENTS.md`):

- windsurf, cline, zed, codex, goose, copilot-agent, jetbrains, openhands, shell-agent — 9 of the 13 docs.
  Of these, only goose's claimed tier (C) matches the fallthrough result; windsurf/cline/zed/codex/
  jetbrains claim B against a C fallthrough, and openhands/shell-agent claim C against the B (generic)
  their own `AGENTS.md` setup triggers.
- `copilot-agent` is the only undetectable host whose claimed tier (B) is plausibly reproducible — but
  only via the generic-AGENTS path, and the host is reported as "Generic Agent", not "Copilot".

**Summary:** 4 hosts are genuinely detectable; 9 documented hosts are not detectable by `envseal doctor`,
and for 8 of those 9 the tier the doc publishes does not match the tier the tool will report for the
documented setup.
