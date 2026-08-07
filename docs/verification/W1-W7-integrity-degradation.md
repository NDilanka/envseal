# W1 + W7 — Build/publish integrity and degradation testing

**Workstreams:** W1 (build, install and publish integrity), W7 (degradation and failure-mode testing)
**Platform:** Windows 11, Node v24.14.1, pnpm 11.17.0, npm 11.x
**Repo state:** `main` @ `fe96400`
**Date:** 2026-08-07

Probes added by this workstream (no product code was changed):

| Script | Covers |
|---|---|
| `scripts/probe-w7-prompter.mjs` | prompter selection matrix; `env_request` under `CI=1` with a hard watchdog |
| `scripts/probe-w7-git.mjs` | the git-safety gate: no repo / tracked `.env` / no `.gitignore` / uncovered `.gitignore` |
| `scripts/probe-w7-fs.mjs` | read-only `.env`; `.env` locked by another process; SIGKILL mid-write |
| `scripts/probe-w7-state.mjs` | missing `.envseal/`; truncated salt; corrupt `approvals.json`; four classes of corrupt manifest |
| `scripts/probe-w7-concurrency.mjs` | two writers / two brokers on one project; ticket TTL expiry |

---

## 1. W1 — Build, install and publish integrity

### 1.1 Clean-clone reproducibility

Cloned to `C:\Users\A S U S\AppData\Local\Temp\envseal-w1-clone\env` — outside the working tree.
Full log: `C:\Users\A S U S\AppData\Local\Temp\envseal-w1-clone\clone.log`.

| # | Command | Exit code |
|---|---|---|
| 1 | `git clone D:/dev/Experiments/env <tmp>/env` | **0** |
| 2 | `pnpm install --frozen-lockfile` | **0** |
| 3 | `pnpm build` | **0** |
| 4 | `pnpm typecheck` | **0** |
| 5 | `pnpm test` | **0** |

Test totals from the clean clone: **442 passed, 1 skipped, 44 test files** across
protocol 56 · registry 14 · detector 40 · prompters 26 (+1 skipped) · core 130 ·
plugin-claude-code 113 · sdk 11 · mcp-server 22 · http-server 9 · cli 18 · portability 3.

`git status --porcelain` in the clone after `pnpm build` was **empty** — the generators that
write into `spec/sep-1/` (`packages/protocol/scripts/gen-schemas.ts`,
`packages/mcp-server/scripts/gen-dialects.ts`) are deterministic and do not dirty the tree.

**E1 is satisfied on Windows only.** Linux and macOS remain unexercised (U9); CI has still
never run (U7), though `.github/workflows/ci.yml` does cover a 3-OS × 2-node matrix.

This evidence is for commit `fe96400`. Other workstreams have since modified the working tree
(including `packages/prompters/src/loopback.ts`), so the clean clone must be re-run before
sign-off on whatever commit is actually published.

One non-fatal install warning, reproducible on every clean install:

```
[WARN] Failed to create bin at ...\packages\cli\node_modules\.bin\envseal-mcp.
       ENOENT: stat '...\packages\mcp-server\dist\bin.js.EXE'
```

pnpm links bins at install time, before `pnpm build` has produced `dist/bin.js`. Cosmetic in
the workspace (the bin works after build) and irrelevant to published tarballs, where npm
links bins from the tarball's own `dist/`.

### 1.2 Tarball manifests

`npm pack --dry-run --json` in each publishable package. `plugins/claude-code`
(`@envseal/plugin-claude-code`) and `extensions/vscode` (`envseal-vscode`) are both
`private: true` and correctly excluded. `packages/examples/custom-agent` has no
`package.json` and is not a workspace package.

| Package | Files | Size | `files` field | `src/` | tests | `*.tsbuildinfo` | `.envseal/` | `.env*` | `main`/`types` resolve | `bin` present + shebang |
|---|---|---|---|---|---|---|---|---|---|---|
| `@envseal/cli` | 69 | 19 KB | `["dist"]` | no | no | no | no | no | yes | `envseal` → `dist/bin.js`, `#!/usr/bin/env node` ✓ |
| `@envseal/core` | 61 | 30 KB | `["dist"]` | no | no | no | no | no | yes | n/a |
| `@envseal/detector` | 21 | 23 KB | `["dist"]` | no | no | no | no | no | yes | n/a |
| `@envseal/http-server` | 13 | 5.6 KB | `["dist"]` | no | no | no | no | no | yes | n/a |
| `@envseal/mcp-server` | 49 | 11 KB | `["dist"]` | no | no | no | no | no | yes | `envseal-mcp` → `dist/bin.js`, `#!/usr/bin/env node` ✓ |
| `@envseal/prompters` | 33 | 19 KB | `["dist"]` | no | no | no | no | no | yes | n/a |
| `@envseal/protocol` | 17 | 9.6 KB | `["dist"]` | no | no | no | no | no | yes | n/a |
| `@envseal/registry` | 50 | 8.2 KB | `["dist","providers"]` | no | no | no | no | no | yes | n/a |
| `@envseal/sdk` | 5 | 4.8 KB | `["dist"]` | no | no | no | no | no | yes | n/a |

**No private, source, or test file ships in any tarball.** Every `files` field is present.

**`@envseal/registry` ships its providers — verified, not assumed.** The tarball contains all
37 `providers/*.json` (`ls packages/registry/providers | wc -l` → 37; tarball entry count for
`providers/` → 37). Confirmed at runtime against a real install rather than the workspace:

```
$ cd <consumer-with-installed-tarballs>
$ node --input-type=module -e "const r=await import('@envseal/registry'); ..."
getProvider(openai): "OpenAI"
findKey(OPENAI_API_KEY): "openai"
allProbeHosts size: 7
```

**`plugins/claude-code`** is `private: true`, so its bundled `hooks/dist/*.cjs`
(`pre-tool-use.cjs`, `session-start.cjs`, `user-prompt-submit.cjs`, all present on disk) never
reach npm. That is the correct handling for a plugin distributed through the Claude Code
marketplace rather than the registry.

### 1.3 Workspace dependencies

Every `workspace:*` dependency resolves to a package that is itself publishable. No published
package depends on a private one. The dependency closure is
`protocol → registry → detector → prompters → core → sdk → http-server / mcp-server → cli`,
and all nine are public.

### 1.4 Bin resolution from an arbitrary cwd

Simulated global install: `pnpm pack` all nine packages, then `npm install` them into a
throwaway consumer as `file:` dependencies (`added 107 packages in 26s`, exit 0).
`node_modules/.bin/` contains `envseal`, `envseal.cmd`, `envseal.ps1`, `envseal-mcp`,
`envseal-mcp.cmd`, `envseal-mcp.ps1`.

| Invocation | cwd | Exit | Result |
|---|---|---|---|
| `node <repo>/packages/cli/dist/bin.js --help` | unrelated temp dir | 0 | full help text |
| `node <installed>/@envseal/cli/dist/bin.js --help` | unrelated temp dir | 0 | full help text |
| `node <installed>/@envseal/cli/dist/bin.js --version` | a third unrelated dir | 0 | `envseal version 0.1.0` |
| `node <installed>/@envseal/mcp-server/dist/bin.js --help` | unrelated temp dir | 0 | **zero bytes on stdout and stderr; created `.envseal/salt` in the cwd** |

Neither bin wrote anything into the repository working tree. The mcp bin does write into
whatever directory it is launched from — see F-W1-3.

### 1.5 W1 findings

---

#### F-W1-1 · **High** · `npm publish` ships `workspace:*` and every install fails

`PLAN.md:1023` (T10.5) prescribes the release command:

> Publish `0.1.0` under Apache-2.0 with provenance attestation (`npm publish --provenance`).

`npm pack`/`npm publish` do **not** rewrite the pnpm `workspace:` protocol. Eight of the nine
tarballs ship it verbatim:

```
--- envseal-cli-0.1.0.tgz
  workspace deps in tarball: {"@envseal/protocol":"workspace:*","@envseal/core":"workspace:*",
    "@envseal/prompters":"workspace:*","@envseal/registry":"workspace:*",
    "@envseal/detector":"workspace:*","@envseal/mcp-server":"workspace:*",
    "@envseal/http-server":"workspace:*"}
```

(`@envseal/protocol` and `@envseal/registry` have no workspace deps and are unaffected.)

**Reproduction:**

```
$ cd packages/detector && npm pack --pack-destination /tmp/t
$ mkdir /tmp/c && cd /tmp/c && echo '{"name":"c","version":"1.0.0"}' > package.json
$ npm install /tmp/t/envseal-detector-0.1.0.tgz
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

`pnpm pack` rewrites correctly — `{"@envseal/registry":"0.1.0"}` — and the nine pnpm-packed
tarballs install cleanly. The fix is to publish with `pnpm publish -r`, and to correct
`PLAN.md` T10.5, which currently documents the command that breaks the release.

#### F-W1-2 · **Medium** · no `publishConfig.access`, so the first scoped publish is rejected

All nine packages are scoped (`@envseal/*`) and none declares `publishConfig`. npm defaults
scoped packages to restricted access; the first `publish` of a new scope fails with
`402 Payment Required` unless `--access public` is passed or `publishConfig.access: "public"`
is set. Recorded as `publishConfig: null` for all nine in the tarball inspection above.

Not verified against the live registry (no npm auth in this environment) — the reasoning is
from the packed `package.json` fields and npm's documented default.

#### F-W1-3 · **Medium** · `envseal-mcp` silently creates `.envseal/` in whatever directory it is launched from, and ignores `--help`

`packages/mcp-server/src/bin.ts:16` computes `findProjectRoot(process.cwd())` unconditionally
and hands it to `new Broker(...)`, whose constructor eagerly calls `loadOrCreateSalt`
(`packages/core/src/broker.ts:77` → `packages/core/src/paths.ts:54`). `findProjectRoot`
(`packages/core/src/paths.ts:34-43`) walks up looking for `env.schema.jsonc`, `.git`, or
`package.json` and **falls back to the original directory** when it finds none. The argument
loop at `bin.ts:20-39` recognises only `--project`, `--http`, `--port`; `--help` falls
through silently.

**Reproduction:**

```
$ mkdir /tmp/iso && cd /tmp/iso
$ node <install>/node_modules/@envseal/mcp-server/dist/bin.js --help </dev/null
$ echo "exit=$?"        # exit=0
$ ls -aR .
.:  ./  ../  .envseal/
./.envseal:  ./  ../  salt
```

Zero bytes on stdout, zero on stderr, exit 0, and a new `.envseal/salt` in an unrelated
directory. An MCP host that launches the server with a cwd the user did not choose will scatter
`.envseal/` directories, and — more importantly — the broker will treat that directory as the
project root, so requests silently target the wrong project. The repository itself is never
written to.

#### F-W1-4 · **Low** · source maps ship without sources

Every tarball includes `*.js.map` and `*.d.ts.map` whose `sources` are `../src/*.ts`, with no
`sourcesContent`. `src/` is correctly excluded, so every map in the published packages is
dangling. Either add `"sourcesContent"` (via `declarationMap`/`inlineSources`) or drop the
maps from `files`.

#### F-W1-5 · **Low** · `pnpm-workspace.yaml` glob `examples/*` matches nothing

There is no top-level `examples/` directory; the example lives at
`packages/examples/custom-agent` and has no `package.json`, so it is neither a workspace
package nor type-checked nor built by `pnpm -r build`.

---

## 2. W7 — Degradation and failure modes

All probes use `mkdtempSync(join(tmpdir(), ...))` roots. No probe was pointed at the repo, and
every temp root is removed on exit. Every scenario that could plausibly block ran under a hard
watchdog (`spawnSync` `timeout` + `SIGKILL`, or `timeout(1)`).

### 2.1 Scenario table

| # | Scenario | Expected | Observed | Severity |
|---|---|---|---|---|
| 1 | `CI=1` → prompter selection | `none` | `none` in 505 ms | — |
| 1b | `CI=true` / `CI=0` / `CI=""` | `none` (presence, not truthiness) | `none` in all three | — |
| 1c | no `CI` | `loopback-browser` | `loopback-browser` | — |
| 1d | no `CI`, `SEP_PREFER_NATIVE=1` | `native-dialog` | `native-dialog` | — |
| 1e | `CI=1` + `SEP_PREFER_NATIVE=1` | `none` (CI wins) | `none` | — |
| 1f | no `CI`, `allowTty`, no TTY on stdin | `loopback-browser` (tty unavailable) | `loopback-browser` | — |
| 2 | `CI=1` → `env_request` | raise `SEP_NO_INTERACTIVE_SURFACE`; **must not hang** | **no hang** (534 ms), but returns a *successful ticket*; `env_await` then reports `state:"cancelled", keys:[]`. `SEP_NO_INTERACTIVE_SURFACE` never reaches the caller | **High** (F-W7-1) |
| 3 | `envseal set` / `ensure` under `CI=1` | exit **4** `NO_SURFACE` per `docs/cli-contract.md:13` | exit **1**; `Error: No outcome returned` / `✗ Only 0/1 keys set` | **High** (F-W7-1) |
| 4 | project is not a git repo | write allowed | wrote; `.env` contains the value | — |
| 5 | git repo, `.env` **tracked** | `SEP_GITIGNORE_UNSAFE`, no write | `SEP_GITIGNORE_UNSAFE`; pre-existing `.env` byte-for-byte identical; sentinel absent | — |
| 6 | git repo, `.gitignore` **missing** | `SEP_GITIGNORE_UNSAFE`, no write | `SEP_GITIGNORE_UNSAFE`; no `.env` created | — |
| 7 | git repo, `.gitignore` does not cover `.env` | `SEP_GITIGNORE_UNSAFE`, no write | `SEP_GITIGNORE_UNSAFE`; no `.env` created | — |
| 8 | files left behind after a refused write | none | `[]` | — |
| 9 | atomic-write temp file vs `.gitignore` | covered like `.env` | `..env.<hex>.tmp` is **not** matched by a `.gitignore` of `.env`; shows as `?? ..env.deadbeefcafe.tmp` | **Medium** (F-W7-3) |
| 10 | `.env` is read-only | clean failure, file untouched | raw `EPERM` (not `SEP_SINK_WRITE_FAILED`); file unchanged; sentinel absent; no stray `.tmp` | **Medium** (F-W7-4) |
| 11 | `.env` held open, `FileShare.None` | clean failure, file intact | raw `EBUSY` after 41 ms — fails at `readFileIfPresent`, **before** the rename retry loop; file intact; no stray | **Medium** (F-W7-4) |
| 12 | `.env` held open, `FileShare.Read` (retry loop exercised) | ~193 ms of retries then a clean throw | `EPERM` after **303 ms** — retries exhausted as designed; file intact; `unlinkSync` cleanup succeeded, **no plaintext temp left** | — |
| 13 | SIGKILL mid-write, 15 rounds × 200 KB | `.env` never truncated | `truncated=0 unparseable=0 keyMissing=0`, `leftoverTmp=0` | — |
| 14 | SIGKILL mid-write, 40 rounds × 4 MB | `.env` never truncated | `truncated=0 unparseable=0 keyMissing=0`, `leftoverTmp=0` | — |
| 15 | `.envseal/` missing | created on demand | created; `describe()` returns cleanly | — |
| 16 | `.envseal/salt` truncated to 0 bytes | loud failure or documented regeneration | silently regenerated to 32 bytes, no error, no log | **Low** (F-W7-5) |
| 17 | `.envseal/salt` truncated to 3 bytes | same | silently regenerated to 32 bytes | **Low** (F-W7-5) |
| 18 | `approvals.json` corrupt JSON, non-allowlisted probe host | fail closed | `probe_not_approved` | — |
| 19 | `approvals.json` empty / forged ids | fail closed | `probe_not_approved` in both | — |
| 20 | manifest truncated mid-object | loud rejection; never treated as empty; never overwritten | `describe` → `entries:[]`; `request` → `SEP_NOT_DECLARED`; `declare` **rewrote the file and dropped the prior declaration** | **High** (F-W7-2) |
| 21 | manifest with unknown top-level field | same | identical to #20 | **High** (F-W7-2) |
| 22 | manifest entry with unknown field (`.strict()`) | rejected loudly | identical to #20 — no `SEP_VALUE_IN_REQUEST`, no error at all | **High** (F-W7-2) |
| 23 | manifest `"version": 2` | rejected, or migrated | identical to #20; the file is silently downgraded to `version: 1` | **High** (F-W7-2) |
| 24 | two processes × 400 writes, same key | file parses, one complete value | 1 assignment line, value `alpha-0399`, 0 unparseable lines, 0 stray `.tmp` | — |
| 25 | two processes × 300 writes, different keys | both keys survive | `KEY_ALPHA=ALPHA-0297`, `KEY_BRAVO=BRAVO-0299`, both present | — |
| 26 | two `Broker`s, both request the same key | both resolve; one complete value | both `state:"resolved"`, both `outcome:"stored"`; 1 line; `value-from-broker-B` | — |
| 27 | `await()` on a pending ticket, nothing else holding the event loop | settles within `timeoutMs` | **never settles** — exit 13, `Detected unsettled top-level await`, no output | **Medium** (F-W7-6) |
| 28 | `await()` past TTL, sweep not yet run | `expired`, promptly | `pending`, after the full 2012 ms await timeout | **Medium** (F-W7-6) |
| 29 | `await()` past TTL, sweep running | `expired` shortly after TTL | `expired` after 342 ms (TTL 300 ms) | — |
| 30 | `await()` on an unknown ticket id | immediate answer, no hang | `expired` after 0 ms | — |

**Nothing hung.** Every scenario produced a result inside its watchdog.

### 2.2 Severity counts

| Severity | Count | Findings |
|---|---|---|
| Critical | 0 | — |
| High | 2 | F-W7-1, F-W7-2 |
| Medium | 3 | F-W7-3, F-W7-4, F-W7-6 |
| Low | 1 | F-W7-5 |

Combined with W1: **2 High, 4 Medium, 3 Low, 0 Critical.**

### 2.3 W7 findings

---

#### F-W7-1 · **High** · `SEP_NO_INTERACTIVE_SURFACE` and CLI exit code 4 are both unreachable

`docs/cli-contract.md:13` documents the contract:

| 4 | `NO_SURFACE` | No interactive prompt surface available (e.g., CI) | Yes |

and `docs/hosts/openhands.md:28` states it verbatim: *"`ensure` fails with `no interactive
surface` (exit 4), which is the correct…"*. `packages/cli/src/exit-codes.ts` maps
`SEP_NO_INTERACTIVE_SURFACE → EXIT.NO_SURFACE (4)`.

Neither the error code nor the exit code can be produced. `NonePrompter.prompt`
(`packages/prompters/src/none.ts:22`) does throw `SEP_NO_INTERACTIVE_SURFACE`, but it is
thrown inside `Broker.startPrompt`, whose catch-all discards it:

```ts
// packages/core/src/broker.ts:330-332
} catch (error) {
  this.ticketStore.cancel(ticketId);
}
```

`startPrompt` is itself invoked fire-and-forget at `broker.ts:214`
(`this.startPrompt(...).catch(() => {})`), so the error has nowhere else to go. The caller sees
a ticket that later reports `cancelled` — which per `SEP_ERROR_DEFAULTS` means *"The user
cancelled the request"*. In CI there is no user.

**Reproduction (library):**

```
$ CI=1 node scripts/probe-w7-prompter.mjs
=== 2. env_request under CI=1 (hard 20s watchdog) ===
  exit=0 in 534ms
  REQUEST {"threw":false,"surface":"none",
           "userMessage":"No interactive surface is available; W7_KEY must be provided out of band.",
           "ticket":"01KZD5MXMV5AMB25YHVKABEJVC"}
  AWAIT   {"ticket":"01KZD5MXMV5AMB25YHVKABEJVC","state":"cancelled","keys":[]}
```

**Reproduction (shipped CLI):**

```
$ mkdir /tmp/p && cd /tmp/p && git init -q . && printf '.env\n' > .gitignore
$ CI=1 node <repo>/packages/cli/dist/bin.js init          # exit 0
$ CI=1 node <repo>/packages/cli/dist/bin.js set W7_KEY
Error: No outcome returned
   exit=1                                                  # documented: 4
$ CI=1 node <repo>/packages/cli/dist/bin.js ensure
✗ Only 0/1 keys set
   exit=1                                                  # documented: 4
```

`Error: No outcome returned` comes from `packages/cli/src/commands/set.ts:39`, which throws a
bare `Error` when `result.keys` is empty — and `keys` is empty precisely because no per-key
outcome was ever recorded. A CI script cannot distinguish "no prompt surface" from any other
failure, and the message tells a human nothing.

There is no hang, and no secret is at risk. What fails is a documented guarantee on the primary
CI path, in a code path a host guide instructs users to rely on.

Related, and worth fixing in the same pass: `packages/cli/src/output.ts:22` initialises
`code = 0` and only assigns a non-zero value for `SepError`, `Error`, and `string`. A thrown
value of any other type exits **0** from `fail()` — a silent success. Not reachable from
current code, but it is a failure path that defaults to "OK".

#### F-W7-2 · **High** · a corrupt manifest is silently treated as empty, and the next `declare` overwrites it

`loadManifest` (`packages/core/src/manifest.ts:33-44`) returns `null` for *every* failure —
JSONC parse errors and Zod validation failures alike:

```ts
if (errors.length > 0) return null;
const result = Manifest.safeParse(value);
return result.success ? result.data : null;
```

Every caller then writes `loadManifest(this.paths) ?? emptyManifest()` — seven times in
`broker.ts` (lines 94, 145, 182, 234, 341, 381, 408) and once in `manifest.ts:88`. A corrupt
manifest is therefore indistinguishable from a project that has declared nothing, and
`declareEntries` proceeds to `saveManifest` that empty view over the user's file.

All four corruption classes behave identically:

```
$ node scripts/probe-w7-state.mjs
5. manifest truncated mid-object
   describe : OK {"entries":[],"missingRequired":[]}
   request  : THREW SEP_NOT_DECLARED: The key was not declared in the manifest.
   declare  : OK {"added":["W7_NEW"],"updated":[],"unchanged":[]}
   manifest rewritten by declare: true
   original W7_KEY declaration survived: false
   !! corrupt manifest silently reported as EMPTY  <-- HIGH
   !! declare OVERWROTE the manifest and DROPPED prior declarations  <-- HIGH (data loss)

6. manifest with an unknown TOP-LEVEL field      -> identical
7. manifest entry with an unknown field          -> identical
8. manifest with "version": 2                    -> identical
```

Three consequences, in order of severity:

1. **Data loss.** A merge conflict marker, a truncated write, or a hand-edit typo in
   `env.schema.jsonc` costs the user every declaration in the file the next time anything calls
   `env_declare`. `.env` is protected by an atomic write; the manifest is not protected by
   anything.
2. **`version: 2` is silently downgraded.** `Manifest.version` is `z.literal(1)`
   (`packages/protocol/src/schemas.ts:66`). A future-version manifest is read as empty, and
   `saveManifest` then rewrites `version` back to `1` — the opposite of what a version field is
   for.
3. **`.strict()` rejection is invisible.** Case 7 planted
   `"value": "leaked-secret-here"` in an entry — exactly the condition `SEP_VALUE_IN_REQUEST`
   exists to report. `declareEntries` does raise it for entries arriving through the *API*
   (`manifest.ts:93-99`), but an entry already sitting in the *file* produces no error at all;
   the whole manifest is just dropped.

`env_describe` returning `{entries: [], missingRequired: []}` for a project whose manifest is
unreadable is the plainest possible instance of the failure mode `VERIFICATION.md` §0 was
written about: a green, confident, wrong answer.

**Minimal reproduction:**

```
$ mkdir /tmp/m && cd /tmp/m && printf '.env\n' > .gitignore
$ printf '{\n "version": 1,\n "entries": [{"key":"REAL_KEY","description":"d","required":true,"secret":true}],\n "typo": 1\n}\n' > env.schema.jsonc
$ node -e "
  const {Broker} = await import('file:///<repo>/packages/core/dist/index.js');
  const b = new Broker({root: process.cwd(), prompter:{id:'none',available:async()=>true,prompt:async()=>({ticket:'',results:[]}),cancel:async()=>{}}});
  console.log(JSON.stringify(await b.describe()).slice(0,120));
  await b.declare({entries:[{key:'NEW_KEY',description:'d',required:true,secret:true}]});
  b.dispose();
" --input-type=module
$ grep -c REAL_KEY env.schema.jsonc     # 0 — the declaration is gone
$ cat env.schema.jsonc
{
 "version": 1,
 "entries": [
  { "key": "NEW_KEY", "description": "d", "required": true, "secret": true, "sink": "dotenv" }
 ],
 "typo": 1
}
```

Note that `"typo": 1` survives — `saveManifest` uses `jsonc.modify` on the named fields only,
so the manifest stays permanently unreadable *and* has lost its declaration. Every subsequent
`declare` repeats the cycle.

The fix is to make `loadManifest` distinguish "absent" from "unreadable" and raise
`SEP_FORMAT_INVALID` for the latter, rather than collapsing both to `null`.

#### F-W7-3 · **Medium** · the atomic-write temp file is not covered by the `.gitignore` that protects `.env`

`atomicWrite` (`packages/core/src/sinks/dotenv.ts:184-187`) names its temp file
`` `.${basename(target)}.${hex}.tmp` `` — for `.env` that is `..env.<12 hex>.tmp`. A
`.gitignore` containing `.env` does not match it:

```
$ node scripts/probe-w7-git.mjs
  5b. leftover atomic-write temp file "..env.deadbeefcafe.tmp"
    expected : covered by .gitignore just like .env
    observed : gitignored=false
    git status: ["?? ..env.deadbeefcafe.tmp","?? .gitignore"]
```

The file holds the complete plaintext `.env` content. `assertGitSafe` only ever checks the
path of `.env` itself, so the guarantee it enforces does not extend to the temp file the sink
creates one line later.

This is a gap in a defence-in-depth control, not a demonstrated leak. Both cleanup paths held
under test: the rename-failure path unlinks the temp file successfully (scenarios 10–12, zero
strays), and 55 SIGKILLs across two configurations (15 × 200 KB and 40 × 4 MB) left **zero**
temp files behind. **If** a leftover ever survives — hard power loss, OOM kill, a failed
`unlinkSync` on a path that is itself locked — a `git add -A` will stage a plaintext secret,
and the severity becomes Critical. Cheap fix: write the temp file inside `.envseal/`
(already ignored and `0700`), or emit `.env.*` alongside `.env` in the `.gitignore` that
`envseal init` writes.

#### F-W7-4 · **Medium** · sink write failures surface as raw `errno` codes, never as `SEP_SINK_WRITE_FAILED`

`SEP_SINK_WRITE_FAILED` is defined (`packages/protocol/src/errors.ts`), mapped to exit code 5
(`packages/cli/src/exit-codes.ts`), and never raised by the dotenv sink. Every filesystem
failure escapes as the bare Node error:

```
$ node scripts/probe-w7-fs.mjs
1. .env is read-only
   observed : THREW EPERM: EPERM: operation not permitted, rename
              'C:\...\Temp\envseal-w7-readonly-XtZXlk\..env.cfdccc2e44ee.tmp' -> 'C:\...
   file unchanged : true
   contains secret: false
   stray .tmp files: []

2. .env held open by another process (FileShare.None)
   observed : THREW EBUSY: EBUSY: resource busy or locked, open
              'C:\...\Temp\envseal-w7-locked-4ohesD\.env' after 41ms
   file unchanged : true
```

Two sub-issues:

- **No error mapping.** The caller gets `EPERM`/`EBUSY` with a full absolute path, not a SEP
  code. Through the broker it is worse: `startPrompt`'s catch-all (`broker.ts:330-332`) turns any
  sink failure into ticket state `cancelled`, so a model is told the *user* declined when in
  fact the value was entered and the write failed. The `zero(result.value)` call at
  `broker.ts:305` is also skipped on that path, leaving the secret buffer un-zeroed.
- **The retry loop guards only half the operation.** Scenario 11 failed in 41 ms at
  `readFileIfPresent` (`dotenv.ts:175`), which has no retry, so the carefully-built rename
  retry never ran. The same transient AV/indexer handle that motivated
  `RENAME_RETRY_DELAYS_MS` will fail the read just as readily.

The retry loop itself works. Scenario 12 held the file with `FileShare.Read` so the read
succeeded and the rename did not:

```
2b. .env held open with FileShare.Read (rename retry loop exercised)
   observed : THREW EPERM ... after 303ms
   retry budget is 1+2+5+10+25+50+100 = 193ms; elapsed 303ms => retries WERE exhausted
   file unchanged : true
   stray .tmp files: []
```

Retries exhausted, target intact, temp cleaned up. The mechanism is sound; only its coverage
and its error type are wrong.

#### F-W7-5 · **Low** · a truncated salt is silently regenerated

`loadOrCreateSalt` (`packages/core/src/paths.ts:54-66`) accepts the file only when
`existing.length === 32` and otherwise falls through to generating a fresh salt, with no error
and no log. Truncation to 0 bytes and to 3 bytes both behaved identically:

```
2. .envseal/salt truncated to 0 bytes
   observed : no error; salt length now 32; regenerated=true
3. .envseal/salt truncated to 3 bytes
   observed : no error; salt length now 32; regenerated=true
```

Failing closed by regenerating is the right default — the alternative is refusing to start over
a file the user can simply delete. But the salt keys every `fp_*` fingerprint in
`describe()` output and the audit log, so a silent swap makes every previously recorded
fingerprint mean something different with no indication that it changed. A one-line stderr
warning would resolve it.

#### F-W7-6 · **Medium** · `TicketStore.await()` can drop its promise, and never reports `expired` on its own

Both timers in `packages/core/src/tickets.ts` are unref'd — the sweep interval at line 51
(`this.timer.unref()`) and the per-await timeout at line 124 (`timeout.unref()`). With no other
handle holding the event loop open, the awaited promise is simply never settled and Node exits
13:

```
$ node --input-type=module -e "
  import { TicketStore } from 'file:///<repo>/packages/core/dist/tickets.js';
  const s = new TicketStore({ ttlMs: 300, sweepIntervalMs: 60000 });
  const r = s.create({ keys:['K'], reason:'x', surface:'none' });
  const o = await s.await(r.ticket, 2000);
  console.log('SETTLED ' + JSON.stringify(o));
"
Warning: Detected unsettled top-level await at [eval1]:4
$ echo $?
13
```

No output, no error, exit 13. The same test with any ref'd handle present settles normally.

Second issue, visible once the loop is held open: expiry is computed **only** by the 60 s
sweep, so `toOutcome` reports whatever `record.state` currently says. An await that outlives
the TTL returns `pending`:

```
4a. await() on a ticket already past its TTL (sweep interval 60s, not yet run)
   expected : returns promptly with state="expired"
   observed : state="pending" after 2012ms
4b. await() with the sweep running (100ms interval)
   observed : state="expired" after 342ms          (TTL 300ms — correct)
4c. await() on an unknown ticket id
   observed : state="expired" after 0ms            (correct, no hang)
```

With `Broker.request` hard-coding `ttlMs: 600000` (`broker.ts:203`) and `Broker.await`
defaulting to `timeoutMs: 90_000` (`broker.ts:337`), a caller reaches the await timeout long
before the ticket's TTL, so in practice `expired` is only ever produced for tickets the sweep
has already collected. `await()` should evaluate `expiresAt` itself rather than relying on the
sweep.

**Reachability:** exit-13 is reproducible against the exported `TicketStore` and
`Broker.await`, both of which are public API in `@envseal/core` and reachable through
`@envseal/sdk`. It is **not** reproducible through the shipped CLI or MCP server: under `CI=1`
the `none` prompter rejects immediately and cancels the ticket (which is why F-W7-1's CLI runs
exited 1 rather than 13), and the loopback prompter's HTTP server keeps the loop alive. Rated
Medium on that basis rather than High.

---

## 3. What could not be tested, and why

| # | Item | Reason |
|---|---|---|
| 1 | Linux and macOS clean-clone (E1, U9) | Windows-only environment. `.github/workflows/ci.yml` defines the 3-OS matrix but has never run (U7 — no remote). |
| 2 | A real `npm publish` / `pnpm publish` | No npm authentication available. F-W1-1 and F-W1-2 are established from packed `package.json` contents and a real `npm install` of the resulting tarball, not from a registry round-trip. |
| 3 | `publishConfig.access` rejection (F-W1-2) | Requires a live registry and an unclaimed scope. Reasoned from npm's documented default for scoped packages; marked **unverified**. |
| 4 | `keychain` sink under degradation (U3) | Every probe exercised the `dotenv` sink. The keychain sink's failure modes — locked keyring, denied prompt, missing credential manager — remain unexercised. |
| 5 | `tty` prompter (U4) | `selectPrompter({allowTty:true})` correctly declined it with no TTY on stdin, but the adapter itself was never driven by a real terminal. |
| 6 | Disk-full simulation | Requires a quota-limited volume or a filesystem shim; neither is available here. The read-only and locked-file cases cover the adjacent `atomicWrite` failure paths. |
| 7 | A genuine leftover temp file after a crash (F-W7-3) | 55 SIGKILLs across two payload sizes produced zero. The hazard is argued from the `.gitignore` mismatch (which *is* demonstrated) plus the theoretical `unlinkSync` failure path, not from an observed leftover. |
| 8 | Hard power loss / OOM kill | SIGKILL is the most abrupt termination available to a test harness; it does not reproduce a torn `fsync`. The atomicity claim is verified against process death, not against media failure. |
| 9 | F-W7-6 exit-13 through a shipped binding | Reproduced against `TicketStore`/`Broker.await` directly. No CLI or MCP invocation reached it — see the reachability note above. |

## 4. Product code changed

**None.** This workstream added five probe scripts under `scripts/` and this document. No file
under `packages/`, `plugins/`, or `extensions/` was modified.
