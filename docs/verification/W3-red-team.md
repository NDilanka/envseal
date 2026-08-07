# W3 — Security red-team of the network and prompt surfaces

**Workstream:** VERIFICATION.md §2 W3
**Date:** 2026-08-07
**Method:** adversarial execution against the built artifacts, not source review.
Four probe scripts, all runnable and re-runnable:

| Script | Surface | Result |
|---|---|---|
| `scripts/probe-w3-loopback.mjs` | A — loopback-browser prompter | **153 pass / 1 fail** |
| `scripts/probe-w3-http.mjs` | B — local HTTP binding | **79 pass / 0 fail** |
| `scripts/probe-w3-probe.mjs` | C — verification probe path (T8) | **73 pass / 0 fail** |
| `scripts/probe-w3-threats.mjs` | D — threat rows T1–T14 | **13 mitigated / 1 partial** |

Every probe uses `mkdtempSync(join(tmpdir(), …))` project roots containing a `.gitignore`
with `.env`. No probe points a broker at the repository. `scripts/probe-w3-probe.mjs`
generates a throwaway CA into a temp dir and trusts it via `NODE_EXTRA_CA_CERTS`;
`NODE_TLS_REJECT_UNAUTHORIZED` is never set.

---

## 0. Findings by severity

| ID | Severity | Title |
|---|---|---|
| **W3-02** | **High** | The T3 secret-shaped-field detector is never wired into `packages/core`; a secret in `description` / `format.example` is written to the git-committed manifest |
| **W3-01** | **Medium** | Key names are interpolated into `id=""` attributes without escaping (loopback.ts:104,108) |
| W3-03 | Low | The loopback test suite could not have caught the M1 `Origin` regression (fixed — 2 tests added, mutation-verified) |
| W3-04 | Low | `PLAN.md` §5.2 mechanic 4, `docs/threat-model.md` T10 and `spec/sep-1/SPEC.md:475` all specify the `Origin` rule that was just removed, and justify it with a false premise |
| W3-05 | Low | `LoopbackPrompter` is not re-exported from `packages/prompters/src/index.ts` |
| W3-06 | Low | HTTP binding: `/openapi.json` is unauthenticated; an unknown operation returns `200` with an error body; an empty `Origin:` header passes the truthiness check |
| W3-07 | Low | `printf $SECRET` bypasses the hook's `echo $VAR` rule |

**No Critical findings.** No secret reached a transcript, log, or network destination it
should not, on any of the three surfaces.

> **Environment hazard encountered (not a product defect).** Mid-run,
> `packages/core/dist/broker.js` contained `value: value ? value.toString('utf8') : null`
> in the `env_describe` result — a Critical-looking leak — while `packages/core/src/broker.ts`
> was git-clean and contained no such field, and `KeyStatus` is `.strict()` with no `value`
> key. `dist/` is gitignored and its mtime was newer than the source. A concurrently running
> workstream (W2, whose `scripts/probe-w2-oracle.mjs` was present untracked) had left a
> mutated build artifact in the tree. `pnpm -r build` removed it and T1 passes cleanly.
> **Any workstream that imports `dist/` should rebuild first**; results taken against a
> shared, mutable, gitignored build directory are not trustworthy while another agent is
> running.

---

## 1. Surface A — loopback-browser prompter

`packages/prompters/src/loopback.ts`. Driven over raw sockets (`node:net`) rather than
undici, because the attacks under test are about exact header bytes: a `Host` an HTTP client
would normalise, a pipelined second POST, a chunked body that only crosses the cap
mid-stream.

### 1.1 DNS rebinding — `Host` header (§5.2 mechanic 4, T10)

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| `Host: 127.0.0.1:<port>` | 200 | 200 | — |
| `Host: localhost:<port>` | 400 | 400 | — |
| `Host: 127.0.0.1` (no port) | 400 | 400 | — |
| `Host: 127.1:<port>` | 400 | 400 | — |
| `Host: [::1]:<port>` | 400 | 400 | — |
| `Host: 127.0.0.1.:<port>` (trailing dot) | 400 | 400 | — |
| `Host: rebind.attacker.example:<port>` | 400 | 400 | — |
| `Host: LOCALHOST:<port>` | 400 | 400 | — |
| `Host: 0.0.0.0:<port>` | 400 | 400 | — |
| `Host: 0177.0.0.1:<port>` (octal) | 400 | 400 | — |
| `Host: 2130706433:<port>` (decimal) | 400 | 400 | — |
| No `Host` header (HTTP/1.0) | 400 | 400 | — |
| Absolute-form target `GET http://evil.example/t/<nonce>` + valid `Host` | — | 200 | Info |

The comparison is `incoming.headers.host !== expectedHost` — a byte-exact match against
`127.0.0.1:<port>`. Every encoding trick fails closed.

The absolute-form row is informational, not a finding: the authority in the request line is
ignored and only `Host` is validated. Reaching it already requires the 128-bit path nonce,
and the request is same-origin regardless.

### 1.2 `Origin` header — the rule changed during this workstream

The rule under test changed twice while W3 was running. Final implementation:

```ts
const origin = incoming.headers.origin;
const originOk =
  origin === undefined || origin === `http://${expectedHost}` || origin === 'null';
```

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| No `Origin` at all | 200 | 200 | — |
| `Origin: http://127.0.0.1:<port>` (exact) | 200 | 200 | — |
| `Origin: null` | 200 (by design — see below) | 200 | — |
| `Origin: https://evil.example` | 400 | 400 | — |
| `Origin: ` (empty) | 400 | 400 | — |
| `Origin: HTTP://127.0.0.1:<port>` (case) | 400 | 400 | — |
| `Origin: hTTp://…` (mixed case) | 400 | 400 | — |
| `…:<port>/` (trailing slash) | 400 | 400 | — |
| `https://127.0.0.1:<port>` | 400 | 400 | — |
| `http://localhost:<port>` | 400 | 400 | — |
| `http://127.0.0.1` (no port) | 400 | 400 | — |
| `http://127.0.0.1:80` | 400 | 400 | — |
| Wrong port | 400 | 400 | — |
| Strict prefix of expected | 400 | 400 | — |
| Strict suffix of expected | 400 | 400 | — |
| expected + `.evil.example` | 400 | 400 | — |
| `http://evil.example` + expected | 400 | 400 | — |
| `http://127.0.0.1:<port>@evil.example` | 400 | 400 | — |
| expected as a path of an evil origin | 400 | 400 | — |
| `http://[::1]:<port>` | 400 | 400 | — |
| `http://127.0.0.1.:<port>` | 400 | 400 | — |
| `http://127.1:<port>` | 400 | 400 | — |
| Comma-joined duplicate | 400 | 400 | — |
| Duplicate `Origin:` headers | 400 | 400 | — |
| Surrounded by spaces / tabs | 200 (parser strips OWS) | 200 | — |

**`Origin: null` is correct to accept, and the code comment's reasoning checks out.**
This page sets `Referrer-Policy: no-referrer`. Per the Fetch standard, *Append a request
`Origin` header*: for a request whose mode is not `cors` and whose method is neither `GET`
nor `HEAD`, a referrer policy of `no-referrer` sets the serialized origin to `null`. So
`null` is exactly what a browser sends when submitting this form — it is not merely
tolerated, it is the expected value. A consequence worth recording: **the
`origin === http://${expectedHost}` branch is effectively dead code for the real browser
form POST**, which will send `null`.

Accepting `null` is the one cross-origin-inducible value the server allows (a sandboxed
iframe or a `data:` document produces it). The stated justification is that the path nonce
and CSRF token are the real controls. That claim was tested rather than assumed:

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| `Origin: null` + wrong path nonce | 404 | 404 | — |
| `Origin: null` + wrong CSRF | 403 | 403 | — |
| `Origin: null` + no CSRF | 403 | 403 | — |
| `Origin: null` + wrong `Host` | 400 | 400 | — |
| Any of the above storing a value | never | never (`cancelled`) | — |

Neither the nonce nor the CSRF token is readable cross-origin: CSP is `default-src 'none'`,
there are no CORS response headers, and the response is opaque to a cross-origin reader.
The defence-in-depth argument holds.

**End-to-end regression check (the reason for the change):**

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| Same-origin POST with browser `Origin` + valid CSRF | 200, value stored | 200, `entered`, value exact | — |
| Cross-origin POST (`https://evil.example`) | 400, nothing stored | 400, `cancelled` | — |

### 1.3 Path nonce (§5.2 mechanic 2)

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| Correct nonce | 200 | 200 | — |
| Empty nonce | 404 | 404 | — |
| One char short / one char long | 404 | 404 | — |
| Right length, wrong value | 404 | 404 | — |
| Uppercase variant | 404 | 404 | — |
| First byte percent-encoded | 404 | 404 | — |
| Fully percent-encoded | 404 | 404 | — |
| Nonce + query string | 200 | 200 | — |
| Nonce + `%23x` | 404 | 404 | — |
| Trailing slash | 404 | 404 | — |
| `zzz/../<nonce>` (dot-segment normalises) | 200 | 200 | — |
| `/`, `/t`, `/t/`, `/favicon.ico`, `/T/<nonce>`, `//t/<nonce>` | 404 | 404 | — |

**Is `timingSafeEqual` reachable with unequal lengths?** No. `secureEqual` is
`bufA.length === bufB.length && timingSafeEqual(bufA, bufB)` — the length check
short-circuits, so the throwing path is unreachable. A 1-character nonce returns a clean 404
and the listener survives and still serves the correct nonce afterwards. Both were checked
explicitly.

The nonce is `randomBytes(16)` = 128 bits, matching mechanic 2.

### 1.4 CSRF (§5.2 mechanic 7)

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| No CSRF field | 403 | 403 | — |
| Empty CSRF | 403 | 403 | — |
| Case-flipped CSRF | 403 | 403 | — |
| CSRF from a *different* concurrent ticket | 403 | 403 | — |
| Two prompts issue distinct CSRF tokens | distinct | distinct | — |
| Two prompts issue distinct path nonces | distinct | distinct | — |
| Any rejected POST storing a value | never | never | — |
| Replay a valid token after the listener closed | refused | `ECONNREFUSED` | — |

### 1.5 Single use and keep-alive (§5.2 mechanic 8)

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| Second connection after a successful POST | refused | `ECONNREFUSED` | — |
| `Connection: keep-alive` on GET | still `Connection: close` | `close` | — |
| **Two POSTs pipelined in one write, before any response** | one capture only | 1 response on the wire, 1 `entered` result, value = first submission | — |
| Socket state after success | destroyed | closed | — |

The pipelined double-submit is the interesting case: the second request cannot produce a
second capture because `finishPrompt` is guarded by a `settled` flag and `teardown()`
destroys every tracked socket. An already-open keep-alive connection cannot submit twice.

### 1.6 Body cap

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| 60 KiB body | 200 | 200 | — |
| >64 KiB via `Content-Length` | rejected | socket destroyed, no 200 | — |
| Chunked body crossing the cap mid-stream | rejected | `ECONNRESET`, no 200 | — |
| Listener usable after a rejected oversize body | yes | 200 | — |
| Oversize bodies storing anything | never | `cancelled` | — |

### 1.7 Method handling

`PUT`, `DELETE`, `PATCH`, `OPTIONS`, `TRACE`, `HEAD` → 405. `HEAD` in particular is a 405
rather than a body-suppressed 200.

### 1.8 CSP and the reveal-toggle script (§5.2 mechanic 5)

Observed header:

```
default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'; form-action 'self'; base-uri 'none'
```

| Check | Expected | Observed | Severity |
|---|---|---|---|
| `default-src 'none'` | present | present | — |
| `form-action 'self'` | present | present | — |
| `base-uri 'none'` | present | present | — |
| `'unsafe-inline'` / `'unsafe-eval'` | absent | absent | — |
| Wildcard source | absent | absent | — |
| `connect-src` / `img-src` override | absent (so `default-src 'none'` blocks fetch/XHR/beacon/pixel) | absent | — |
| style and script nonces distinct | yes | yes | — |
| `<style nonce>` matches `style-src` | yes | yes | — |
| `<script nonce>` matches `script-src` | yes | yes | — |
| Exactly one `<script>` in the page | yes | yes | — |
| Inline `on*=` handlers | none | none | — |
| Nonces regenerate per prompt | yes | yes | — |
| `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` | present | present | — |
| Security headers on error responses too | present | present | — |
| Input `type="password"`, `autocomplete="off"`, `spellcheck="false"`, `data-1p-ignore`, `data-lpignore` | present | present | — |
| Page renders a previously stored value (mechanic 10) | never | never | — |

The reveal toggle runs under its own nonce, distinct from the style nonce, and there is no
inline handler that would require `'unsafe-inline'`.

Note: the implementation's CSP adds `script-src` and `base-uri` beyond the directive list
written in PLAN §5.2 mechanic 5. That is a strict improvement — the reveal toggle needs a
script nonce, and `base-uri 'none'` blocks `<base>` injection — but the spec text does not
mention them (see W3-04).

### 1.9 HTML injection

Payloads pushed through `reason`, `projectRoot`, `nonce`, `description`, `providerName`,
`formatHint`, `signupUrl`, `docsUrl` and `key`.

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| `<script>` in `reason` | entity-escaped | `&lt;script&gt;` | — |
| `" onmouseover="…` in `reason` | escaped | `&quot;` — no unescaped `on…="` | — |
| `' onfocus='…` in `formatHint` | escaped | no unescaped `on…='` | — |
| `<script>` in `description` / `providerName` | escaped | escaped | — |
| `signupUrl: javascript:alert(…)` | no `href` emitted | no `href` | — |
| `docsUrl: JaVaScRiPt:alert(1)` | no `href` | no `href` | — |
| `docsUrl: data:text/html,<script>…` | no `href` | no `href` | — |
| `docsUrl: vbscript:msgbox(1)` | no `href` | no `href` | — |
| `signupUrl: " javascript:…"` (leading space) | no `href` | no `href` | — |
| `signupUrl: http://evil.example/x" onclick="alert(1)` | quote escaped inside `href` | `href="http://evil.example/x&quot; onclick=&quot;alert(1)"` — inert | — |
| Every rendered `href` is `http(s)` and contains no raw `"` | yes | yes | — |
| **Hostile `key` name breaking out of `id=""`** | escaped | **BREAKOUT** | **Medium (W3-01)** |

A `javascript:` scheme cannot survive: `isHttpUrl` requires a literal `https://` or `http://`
prefix, so anything else emits no anchor at all rather than an anchor with a filtered href.

---

### W3-01 — Key names are interpolated into `id=""` without escaping · **Medium**

**Location:** `packages/prompters/src/loopback.ts:104` and `:108`.

```ts
const sectionId = `field-${key.key}`;
const revealId  = `reveal-${key.key}`;
…
return `    <section class="key" id="${sectionId}">      // ← not escaped
…
        <input type="password" name="${escapeHtml(VALUE_FIELD(key.key))}" id="${revealId}"   // ← not escaped
```

Every other interpolation on the page goes through `escapeHtml`. These two do not, and
neither `<`, `>` nor `"` is filtered on this path.

**Reproduction:**

```bash
node scripts/probe-w3-loopback.mjs          # section A10, last check
```

Rendering a prompt whose key is `A"><img src=x onerror=alert(1)>` produces:

```html
<section class="key" id="field-A"><img src=x onerror=alert(1)>">
```

— the attribute and the tag are both broken out of.

**Why Medium and not High.** Two independent barriers:

1. **Not reachable through the product path.** A key name must satisfy
   `/^[A-Z][A-Z0-9_]{0,63}$/` in the `ManifestEntry` zod schema. A hand-written hostile
   `env.schema.jsonc` — the realistic delivery vehicle, since a malicious PR writes the file
   directly rather than calling `env_declare` — is rejected by `Manifest.safeParse` in
   `loadManifest`, which returns `null` and treats the manifest as absent. Verified in probe
   section A10b, with a control proving the fixture is otherwise valid.
2. **Contained by CSP even if reached.** An injected `<script>` carries no nonce and
   `script-src` is nonce-only; `<iframe>` is blocked by `default-src 'none'`; `<base>` by
   `base-uri 'none'`; a rewritten form target by `form-action 'self'`. Verified in A10c.

It is nonetheless a real escaping-contract violation in the one file that renders
attacker-influenced strings next to a live credential field, and the fix is a two-token
change. **Not fixed here** — it is product code and outside the edit scope for this
workstream.

**Suggested fix:** wrap both interpolations in `escapeHtml`, matching every sibling line.

---

## 2. Surface B — local HTTP binding

`packages/http-server/src/server.ts`. A token is always passed explicitly so the probe never
reads or creates `~/.envseal/api-token`.

### 2.1 Bearer token

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| Correct token | 200 | 200 | — |
| No `Authorization` header | 401 | 401 | — |
| Empty `Authorization` header | 401 | 401 | — |
| `Bearer` with no space | 401 | 401 | — |
| `Bearer ` with empty token | 401 | 401 | — |
| Wrong scheme (`Basic`) | 401 | 401 | — |
| Lowercase scheme (`bearer `) | 401 | 401 | — |
| Token one char short | 401 | 401 | — |
| Token one char long | 401 | 401 | — |
| Correct prefix, wrong suffix | 401 | 401 | — |
| Token uppercased | 401 | 401 | — |
| Embedded space | 401 | 401 | — |
| **1-byte token (unequal length)** | 401, no throw | 401 | — |
| 63-char token + trailing OWS | 401 | 401 | — |
| Correct token + trailing OWS | 200 (RFC 9110 §5.5 strips OWS — same credential) | 200 | — |
| 65 KiB token | rejected before the handler | rejected (Node `maxHeaderSize`) | — |
| Token with an embedded NUL byte | rejected | 400 at the parser | — |
| Server survives all of the above | yes | 200 afterwards | — |
| 401 body reveals the token or its length | never | never | — |

**Does `timingSafeEqual` get called with unequal lengths?** No, and it is double-guarded:

```ts
tokensMatch =
  expectedTokenBuf.length === providedTokenBuf.length &&
  node_crypto.timingSafeEqual(expectedTokenBuf, providedTokenBuf);
```

inside a `try { … } catch { tokensMatch = false; }`. The length check short-circuits, and the
`catch` would still fail closed. Confirmed empirically: a 1-byte token yields a clean 401 and
the server continues serving.

### 2.2 `Host`, `Origin`, bind scope

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| `Host: 127.0.0.1:<port>` | 200 | 200 | — |
| `localhost`, no-port, `127.1`, `[::1]`, trailing dot, `rebind.attacker.example`, decimal | 400 | 400 | — |
| No `Host` header | 400 | 400 | — |
| Bad `Host` without auth | 400 (not 401 — no auth oracle) | 400 | — |
| `Origin: https://evil.example` / `null` / same-origin | 400 | 400 | — |
| **`Origin:` empty value** | 400 | **200** | Low (W3-06) |
| Reachable on routable IPv4 interface | no | `ECONNREFUSED` | — |
| Reachable on `::1` | no | `ECONNREFUSED` | — |

The empty-`Origin` gap is `if (req.headers.origin)` at `server.ts:89` — a truthiness test, so
`Origin:` with an empty value passes. No browser emits that, and the request still needs a
valid bearer token, so this is Low. Note this surface keeps the stricter *reject-any-Origin*
rule, which is correct here: no browser page posts to it.

### 2.3 Method confusion and path handling

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| `GET /v1/env_describe` | 405 | 405 | — |
| `PUT`/`DELETE`/`PATCH`/`OPTIONS`/`TRACE`/`HEAD` on a POST route | 405 | 405 | — |
| `POST /openapi.json` | not the spec | 404 | — |
| `GET /openapi.json` | 200 | 200 | — |
| `GET /openapi.json` **without auth** | — | 200 | Low (W3-06) |
| `GET /openapi.json/` | not the spec | 405 | — |
| `/v1/env_describe/../../etc` | 404 | 404 | — |
| `/v1/env_describe/..%2f..%2fetc` | 404 | 404 | — |
| `/v1/%65nv_describe` | 404 | 404 | — |
| `/v1//env_describe`, `//v1/env_describe` | 404 | 404 | — |
| `/v1/env_describe/`, `//` | 404 | 404 | — |
| `/V1/…`, `/v1/ENV_DESCRIBE` | 404 | 404 | — |
| `/v1/env_describe%00` | 404 | 404 | — |
| `/v1/env_describe%0d%0aX-Injected:%201` | 404, no injected header | 404, none | — |
| `/../../../../etc/passwd` | 404 | 404 | — |

Traversal is structurally impossible: the route regex `^\/v1\/([a-z_]+)$` runs against the
**raw** `req.url`, so it never decodes `%2e%2e` and never sees a normalised path. The `$`
anchor rejects anything with a suffix. A side effect worth knowing: a legitimate query string
(`/v1/env_describe?x=1`) also 404s.

The `/openapi.json` endpoint is served before the auth check. It exposes the tool schema and
the port, never a value or the token (asserted). Low.

### 2.4 Body cap, JSON, reflection, headers

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| Body > 1 MiB | 413 | 413 | — |
| Malformed JSON | 400 | 400 | — |
| Empty body | treated as `{}` | 200 | — |
| Server survives the oversize body | yes | 200 | — |
| Unknown operation `/v1/zzz_not_a_tool` | 404 preferred | **200** with `Unknown tool: zzz_not_a_tool` | Low (W3-06) |
| Canary in `env_declare` entries | key *names* echoed (non-secret by design) | echoed | — |
| Canary in `env_verify` keys | key names echoed | echoed | — |
| Canary in `env_request` reason | not echoed | not echoed | — |
| **Injected `value` field in `env_declare`** | rejected, never echoed | rejected, never echoed | — |
| `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` | present | present | — |
| `Access-Control-Allow-Origin` | absent | absent | — |
| Security headers on 401 | present | present | — |
| Internal error leaks a stack trace or the project path | never | never | — |

**Is there a reflection channel?** Only for key *names* and the operation name. The operation
name is constrained to `[a-z_]+` by the route regex and JSON-escaped on output, so it cannot
carry markup or break the response. Key names are non-secret by protocol design. No request
content that could hold a value is reflected.

---

## 3. Surface C — the verification probe path (T8)

`packages/core/src/verify.ts`, `packages/core/src/approvals.ts`. This is the exfiltration
primitive: a manifest is JSON in a repo, so a malicious PR can point `verify.url` anywhere.
**73 / 73 checks pass.**

The registry allowlist currently contains **7 hosts**. Everything else routes through
per-project consent.

### 3.1 Allowlist bypass

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| `https://api.openai.com/v1/models` (control) | allowlisted | allowlisted | — |
| `https://api.openai.com@attacker.example/collect` | refused | hostname parses as `attacker.example` → refused | — |
| `https://api.openai.com:tok@attacker.example/` | refused | `attacker.example` → refused | — |
| `https://api.openai.com.attacker.example/` | refused | refused | — |
| `https://attacker.example/api.openai.com` | refused | refused | — |
| `https://api.openai.com./v1/models` (trailing dot) | refused | `api.openai.com.` → refused | — |
| `https://api.openai.com../v1/models` | refused | refused | — |
| `https://xn--pi-9lc.openai.com/` (punycode lookalike) | refused | refused | — |
| `https://аpi.openai.com/` (Cyrillic homoglyph) | refused | normalises to `xn--pi-6kc.openai.com` → refused | — |
| `https://attacker.example\@api.openai.com/` | refused | `attacker.example` → refused | — |
| `https://ATTACKER.EXAMPLE/collect` | refused | refused | — |
| Raw IP / loopback / IPv6 literal | refused | refused | — |
| `https://evil.api.openai.com/` (subdomain) | refused | refused | — |
| `https://api.openai.com%00.attacker.example/` | refused | unparseable → refused | — |
| `https://api.openai.com\t.attacker.example/` | refused | refused | — |
| `https://ａpi.openai.com/` (fullwidth IDN) | **allowlisted** | allowlisted | — |

The fullwidth case is **not** a bypass and is correct behaviour: UTS-46 maps fullwidth `ａ`
to ASCII `a`, so `new URL(...).hostname` is literally `api.openai.com` and the request
genuinely goes to OpenAI. An IDN attack would only work if the allowlist check and `fetch`
disagreed about the host.

**That agreement is the load-bearing invariant, and it was tested rather than argued:** the
same URL string is passed to `new URL()` and to `fetch()`, both using the WHATWG parser.
Against a local server, the host the allowlist checks is exactly the `Host` the server
receives. Separately, WHATWG `fetch` refuses any URL that *includes credentials* outright —
so a userinfo URL never reaches the wire at all, a second layer beneath the allowlist.

Every bypass form also returns `probe_not_approved` from `verifyKey` end-to-end with no
network I/O, and no rejection message contains the secret.

### 3.2 `{{value}}` placement

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| `{{value}}` in a query string | rejected | `network_error`, "Probe URL must not contain {{value}}" | — |
| `{{value}}` in the URL path | rejected | rejected | — |
| `{{value}}` in the URL fragment | rejected | rejected | — |
| **`{{value}}` in a header NAME** | not substituted | not substituted — request fails with "invalid header name", no leak | — |
| `{{value}}` in a header value | substituted (intended) | substituted | — |
| `http://` probe URL | refused | "Probe URL must use https://" | — |
| `HTTPS://` (uppercase scheme) | fails closed | `network_error` | — |

Substitution is `headers[key] = templateVal.replace(/\{\{value\}\}/g, valueStr)` — the loop
key is used verbatim as the header name and is never a substitution target. A header name
containing `{{value}}` stays literal and is rejected by `Headers.append` as an invalid name,
so nothing is sent. No rejection message contains the secret.

### 3.3 Approval invalidation

| Mutation | Expected | Observed | Severity |
|---|---|---|---|
| Novel host, no approval | unapproved | unapproved | — |
| After `recordProbeApproval` | approved | approved | — |
| **Header template VALUE changed** | re-consent | re-consent | — |
| **Header template NAME changed** | re-consent | re-consent | — |
| Extra header added | re-consent | re-consent | — |
| URL changed | re-consent | re-consent | — |
| Host changed | re-consent | re-consent | — |
| Method changed | re-consent | re-consent | — |
| Key changed | re-consent | re-consent | — |
| Identical probe re-checked | stays approved (no consent fatigue) | stays approved | — |
| Same approval in a different project | not inherited | not inherited | — |
| `approvals.json` contains a value | never | never | — |
| Consent denied | `probe_not_approved`, nothing recorded | correct | — |
| `expectStatus` changed | — | does **not** re-consent | Info |

Changing only the header template **does** re-trigger consent — the approval id is
`sha256(key:method:url:sha256(canonicalHeaderTemplate))`, and the canonical form sorts keys
so a pure reordering correctly does *not* re-prompt.

`expectStatus` is not part of the approval identity. This is informational rather than a
finding: `expectStatus` changes how a response is classified, and cannot redirect the value
anywhere.

### 3.4 Redirects — does the `Authorization` header travel?

Driven against two real local HTTPS servers with a throwaway CA.

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| Approved host 302s to an unapproved collector | not followed | **0 requests reached the collector** | — |
| The secret reaching the redirect target | never | never | — |
| The origin received the request at all (probe works) | yes | yes, with `Authorization` | — |
| A 302 classified as `ok` | no | `auth_failed` | — |
| 307 redirect (preserves method+body) | not followed | **0 requests reached the collector** | — |
| Upstream 401 body echoing the credential | never surfaces | never surfaces | — |
| Verify message contains the secret | never | never | — |

`redirect: 'manual'` genuinely prevents the `Authorization` header travelling. This is the
single most important result on this surface and it is confirmed empirically, not by
inspection: the collector's request log is empty in both the 302 and 307 cases.

The upstream-body check matters because providers echo credentials in error payloads: a 401
whose body contains `Invalid credential: Bearer <key>` yields only
`{"result":"auth_failed","message":"HTTP 401 from localhost"}`.

### 3.5 TLS (T14)

| Attack | Expected | Observed | Severity |
|---|---|---|---|
| Untrusted self-signed certificate | `network_error`, never `ok` | `network_error` | — |
| TLS failure message contains the secret | never | never | — |
| `NODE_TLS_REJECT_UNAUTHORIZED` honoured anywhere | never | absent from all source | — |

`NODE_TLS_REJECT_UNAUTHORIZED` appears in the repository only in `PLAN.md` and
`docs/threat-model.md` prose, never in code.

---

## 4. Threat table T1–T14

Full machine output: `node scripts/probe-w3-threats.mjs`.

| # | Threat | Attempt | Result | Status |
|---|---|---|---|---|
| T1 | Model asks broker to read back a stored value | Enumerated all 7 protocol tools and every `Broker` prototype method for a value-returning verb; stored a sentinel, called `env_describe`, grepped the response | No read-value verb exists; 0 value-shaped methods; `env_describe` returns metadata only (`fingerprint`, `lengthBucket`) — 0 sentinel hits in 433 bytes | **MITIGATED** |
| T2 | Model shells out (`cat .env`, `printenv`, `echo $KEY`) | Drove the built bundle `hooks/dist/pre-tool-use.cjs` with 11 dumping payloads and 3 legitimate ones, against a real project root with a manifest | 11/11 denied, 0 false positives; denial messages are instructive and name the alternative tool | **MITIGATED** (see W3-07) |
| T3 | Model puts a value in its own request | Submitted a `ManifestEntry` carrying a `value` field; then put a secret-shaped string in `description`, `format.example` and `reason` and grepped every artifact written | **Clause 1 holds** (`.strict()` rejects it, `SEP_VALUE_IN_REQUEST`). **Clause 2 absent** — the detector fires on the string but `packages/core` never calls it. Secret lands in the git-committed `env.schema.jsonc` and in `audit.jsonl` | **PARTIAL — W3-02, High** |
| T4 | User pastes the key into chat | Drove `hooks/dist/user-prompt-submit.cjs` with 4 pasted credentials (OpenAI, GitHub PAT, AWS key id, postgres URL with inline password) and 1 benign prompt | 4/4 redacted before reaching the model; benign prompt passed through intact | **MITIGATED** |
| T5 | Secret leaks via subprocess output | Ran a child printing the injected value raw, base64, URL-encoded, JSON-escaped and truncated-to-24-chars; grepped combined stdout+stderr | 0 sentinel hits in any encoding | **MITIGATED** |
| T6 | Secret leaks via process listing / crash dump | Checked the broker's own `process.env` after `runWithSecrets`; confirmed injection is via spawn options not argv; checked the residual risk is documented | Parent env not polluted; injection scoped per-invocation to the child; `/proc/<pid>/environ` documented in `exec.ts`. **The same-uid `/proc` read is OUT OF SCOPE** by PLAN §2.3 / §9.3 — undefendable without a sandbox | **MITIGATED** (residual out of scope) |
| T7 | `.env` gets committed | Stored into a git repo where `.env` is neither gitignored nor tracked; and into a repo where `.env` is already tracked | Both refuse with `SEP_GITIGNORE_UNSAFE`; nothing written. Outside a git work tree `assertGitSafe` returns early **by design** — a file cannot be committed to a repo that does not exist | **MITIGATED** |
| T8 | Malicious manifest exfiltrates via its validation probe | 19 allowlist-bypass URLs, `{{value}}` in 5 positions, 7 approval mutations, 302 and 307 redirect follow, untrusted TLS | Every bypass refused; `redirect: 'manual'` confirmed — 0 requests reached the redirect target; 73/73 | **MITIGATED** |
| T9 | Local phishing: lookalike input page | Nonce rendering, single-use enforcement, cross-ticket CSRF | Display nonce rendered in the page header and returned in the ticket `userMessage`; 128-bit path nonce constant-time compared; listener single-use (`ECONNREFUSED`), bound to `127.0.0.1:0`. **Residual:** the user must actually compare the two nonces — a UX control, only closable by manual gate M1 | **MITIGATED** (UX residual) |
| T10 | DNS rebinding against the loopback server | 12 `Host` variants, 22 `Origin` forms | `Host` must equal `127.0.0.1:<port>` exactly; every encoding trick 400s. `Origin` must match when present (rule changed 2026-08-07 — see §1.2); 22 near-miss forms all 400 | **MITIGATED** |
| T11 | Prompt injection drives `env_request` + exfiltration | Passed a jailbreak string as `reason`; called `env_use` with a curl to an attacker host and denied the confirmation | `reason` reached the prompter **verbatim and unsummarised**; project path shown; confirmation fired with `networkEgress=true` and the full argv; denial → `SEP_CONFIRMATION_DENIED`. **Residual (PLAN §9.1):** a user who approves defeats it — the control is UX, not cryptography | **MITIGATED** (residual documented) |
| T12 | Broker writes the value into its own log | Ran declare → request → await → verify → revoke, then grepped every file the broker wrote | 0 sentinel hits across all 4 written artifacts; `audit.jsonl` carries names and fingerprints only | **MITIGATED** |
| T13 | Value persists in memory / swap | `zero()`d a `SecretValue` and inspected the buffer; ran a full store and inspected the prompter-supplied buffer afterwards | `zero()` leaves an all-zero buffer; the ticket buffer is zeroed after the sink write. **Residual (PLAN §9.2):** the transient `unsafeSecretToUtf8` string inside the sink writer cannot be zeroed — documented, not fixed | **MITIGATED** (residual documented) |
| T14 | MITM on the verification probe | Probed an HTTPS endpoint presenting an untrusted self-signed certificate | `http://` refused before any I/O; untrusted cert → `network_error`, never `ok`; no TLS-bypass env var read anywhere in source | **MITIGATED** |

**Explicitly out of scope by design** (stated rather than skipped):

- **T6 residual — same-uid `/proc/<pid>/environ`.** Any same-uid process on Linux can read an
  `env_use` child's environment. PLAN §2.3 excludes a compromised local machine and §9.3
  documents this specific case. Undefendable without a sandbox. The *in-scope* half of T6 —
  that injection is opt-in, per-invocation, child-scoped, and never in argv or the broker's
  own env — was attacked and holds.
- **A malicious harness.** PLAN §2.3 and §9.4. A stdio MCP server's parent can read its fds;
  SEP/1's answer is that the value never crosses those fds, which is why the
  request/await split exists. Not attackable from inside this workstream.
- **A user who deliberately approves an exfiltrating `env_use`.** PLAN §2.3 and §9.1. The
  confirmation fires correctly with the egress flag and full command (verified in T11);
  clicking through it is out of scope.
- **Browser extensions reading the loopback page DOM.** PLAN §9.5. Mitigated by CSP and
  single-use pages, not eliminated. Requires a real browser with an extension — not
  reproducible here.

---

## 5. The ten §5.2 loopback mechanics

| # | Mechanic | Enforced? | Evidence |
|---|---|---|---|
| 1 | Bind `127.0.0.1:0`, IPv4 only, not `::1` or `0.0.0.0` | **Yes** | `ECONNREFUSED` on `::1` and on the routable Wi-Fi interface (A12) |
| 2 | 128-bit path nonce + 6-char display nonce | **Yes** | `randomBytes(16)`; display nonce rendered in the page header; 12 nonce attacks all 404 |
| 3 | Open with the platform opener | **Yes** (code) | `openBrowser()` per-platform; end-to-end launch is manual gate M1 |
| 4 | `Host` exact; `Origin` rule; nonce constant-time compared | **Yes — but the spec text is now wrong** | 12 `Host` + 22 `Origin` attacks; `secureEqual` length-guards `timingSafeEqual`. See W3-04 |
| 5 | `Cache-Control`, `Referrer-Policy`, CSP, `X-Frame-Options` | **Yes, and stronger than specified** | All present, including on error responses; CSP adds `script-src` and `base-uri 'none'` beyond the spec list |
| 6 | `type="password"`, `autocomplete="off"`, `spellcheck="false"`, `data-1p-ignore`, `data-lpignore`, reveal toggle | **Yes** | All five attributes asserted; reveal toggle runs under its own script nonce |
| 7 | POST to the same nonce path with a ticket-bound CSRF token | **Yes** | 4 CSRF attacks incl. cross-ticket token → 403 |
| 8 | On success: terminal page, then close the listener immediately; single-use | **Yes** | `ECONNREFUSED` on reconnect; pipelined second POST yields no second capture; sockets destroyed |
| 9 | On timeout: listener closes, ticket marked `timeout`, ports released | **Yes** | Every key `timeout`; port `ECONNREFUSED` afterwards (A12) |
| 10 | The page never displays a previously stored value | **Yes** | No `value=` on any password input |

**All ten are enforced by the implementation.** The one problem is with mechanic 4's
*specification*, not its implementation — see W3-04.

---

## 6. Remaining findings

### W3-02 — The T3 detector is never wired into the broker · **High**

**Claim under test (PLAN §2.2, T3):** *"Any request whose free-text fields match the
secret-shaped detector is rejected, logged, and surfaced to the user."*

**Observed:** the first clause of T3 (no `value` field, enforced by `.strict()`) holds and is
well tested. The second clause does not exist. `packages/core` has no dependency on
`@envseal/detector` and never calls `detect()` — confirmed by grep across
`packages/core/src/**`, whose only hit for the error code is a schema-strictness branch in
`manifest.ts:95`.

The detector itself works: `detect()` flags the test string with `confidence: "high"`.
It is simply never invoked on the broker's free-text inputs.

**Reproduction:**

```bash
node scripts/probe-w3-threats.mjs   # row T3
```

Minimal form:

```js
const broker = new Broker({ root, prompter });
await broker.declare({ entries: [{
  key: 'OPENAI_API_KEY',
  description: `use ${SECRET}`,                 // free-text field
  format: { pattern: '^sk-.+$', example: SECRET },   // free-text field
  required: true, secret: true,
}]});
await broker.request({ keys: ['OPENAI_API_KEY'], reason: `the key is ${SECRET}` });

readFileSync(paths.manifest, 'utf8').includes(SECRET)  // → true
readFileSync(paths.audit,    'utf8').includes(SECRET)  // → true
```

Observed audit record:

```json
{"type":"request","ticket":"01KZD74…","keys":["OPENAI_API_KEY"],
 "reason":"the key is sk-W3REASONLEAK000000000000000000000000000","surface":"none",…}
```

**Why High rather than Medium.** `env.schema.jsonc` is **committed to git** by design
(PLAN §6.1 — "Committed to git — it contains no values, only declarations"). A model that
copies a real credential into `description` or `format.example` writes it into a
version-controlled file, which is precisely the outcome the product exists to prevent, and
the manifest is the artifact the design holds up as safe to review in a PR. Under
VERIFICATION.md §3 this is "a documented guarantee does not hold".

**Why not Critical.** It does not breach the central claim. Reaching it requires the model to
already hold the value, meaning the primary leak (into the transcript) has already occurred
upstream — and the `UserPromptSubmit` hook that intercepts the common source of that,
a user pasting into chat, works correctly (T4, 4/4). No *broker-collected* secret can reach
these fields.

**Suggested fix:** run `detect()` over `reason` in `Broker.request` and over `description` /
`format.example` in `Broker.declare`, and reject with `SEP_VALUE_IN_REQUEST`. This is the
mitigation the threat model already promises, and the detector is already built, tested and
in the workspace.

**Not fixed here** — product code, outside this workstream's edit scope.

### W3-03 — The loopback suite could not have caught the M1 `Origin` regression · Low · **fixed**

`packages/prompters/test/loopback.test.ts` drives the server with undici, which sends no
`Origin` header. The suite therefore stayed green (7/7) while the default input surface
returned 400 to every real browser submit — the exact VERIFICATION.md §0 pattern of a test
that exercises the code but not the artifact's real usage.

No test asserted the old rule *in a way that now fails*: `it('rejects any Origin header with
400')` used `https://evil.local`, which is still correctly rejected. So nothing broke; the
problem is that nothing covered the accept path.

**Changes made — stated explicitly, not silent:**

1. Renamed `rejects any Origin header with 400` → `rejects a cross-origin Origin header with
   400`. The assertion is unchanged; only the name, which described a rule the code no longer
   implements.
2. Added `accepts the same-origin Origin header a browser actually sends`.
3. Added `stores a submitted value when the POST carries the browser Origin` — a full
   round-trip asserting the value is `entered` and byte-exact.

**Mutation-verified.** With the `Origin` rule reverted to `if (origin !== undefined)`, both
new tests fail with `expected 400 to be 200`; restored, all 9 pass. No assertion was weakened.

> One caveat on these two tests: they send `Origin: http://127.0.0.1:<port>` (the exact-match
> branch). A real Chrome submitting this form sends `Origin: null`, because the page sets
> `Referrer-Policy: no-referrer` (§1.2). The tests therefore guard the rule but do not
> reproduce the precise browser value. `scripts/probe-w3-loopback.mjs` §A2/A2c covers `null`
> and its containment. Adding a `null`-origin round-trip to the suite would close this.

### W3-04 — Three documents specify the removed `Origin` rule, with a false premise · Low

| File | Text |
|---|---|
| `PLAN.md` §5.2 mechanic 4 | "no `Origin` header present (a browser only sends `Origin` cross-origin for these methods, so its presence means the request did not come from the page we served)" |
| `docs/threat-model.md` T10 | "Presence of an `Origin` header is rejected (browsers only send Origin cross-origin…)" |
| `spec/sep-1/SPEC.md:475` | "Reject any request with an `Origin` header (browsers only send Origin cross-origin, so presence indicates spoofing). Reject with 400." |

The parenthetical is factually wrong and is what produced the bug. Per the Fetch standard
(*Append a request `Origin` header*), for a request whose mode is not `cors` and whose method
is neither `GET` nor `HEAD`, the `Origin` header is appended **always** — same-origin
included. It is only serialized as `null` (rather than omitted) under certain referrer
policies.

`spec/sep-1/SPEC.md` is the published normative artifact, so a third-party implementer
following it today would build the same broken surface.

**Suggested replacement wording for all three:**

> Reject any request whose `Host` is not exactly `127.0.0.1:<port>`. If an `Origin` header is
> present, it MUST equal `http://127.0.0.1:<port>` or be `null`; any other value is rejected
> with 400. (Browsers send `Origin` on every POST, including same-origin ones; because this
> page sets `Referrer-Policy: no-referrer`, the browser serializes that origin as `null`.
> `Origin` is defence-in-depth here — the primary controls are the 128-bit path nonce and the
> ticket-bound CSRF token, neither of which is readable cross-origin.)

Mechanic 5's directive list should also be updated to include `script-src 'nonce-…'` and
`base-uri 'none'`, which the implementation ships and the spec omits.

**Not edited** — these are spec/docs owned by W5, and PLAN.md is the governing document.

### W3-05 — `LoopbackPrompter` is not re-exported · Low

`packages/prompters/src/index.ts` exports only `selectPrompter` / `allPrompters`. A Tier-2
consumer importing `@envseal/prompters` cannot construct a `LoopbackPrompter` with options
(`openBrowser`, `onListening`), so they cannot suppress the browser launch or observe the
listening port. **Agreed, this is a gap.** The probes here reach it via a deep path import
into `dist/loopback.js`, which is not a public entry point and would break under a
`package.json` `exports` map that omits subpaths — a real risk given W1 is auditing exactly
that.

### W3-06 — HTTP binding wrinkles · Low

Three, none exploitable: `/openapi.json` served without auth (schema and port only, no token
or value); an unknown operation returns `200` with an error body where `404` would be honest;
`if (req.headers.origin)` at `server.ts:89` is a truthiness test, so a header with an empty
value passes. No browser sends an empty `Origin`, and a valid bearer token is still required.

### W3-07 — `printf $SECRET` bypasses the `echo` rule · Low

`echoReferencesSecret` gates on `/\becho\b/`. With a manifest declaring `OPENAI_API_KEY`:

| Command | Observed |
|---|---|
| `echo $OPENAI_API_KEY` | DENY |
| `echo ${OPENAI_API_KEY}` | DENY |
| `echo "$OPENAI_API_KEY"` | DENY |
| **`printf $OPENAI_API_KEY`** | **ALLOW** |
| `echo $PUBLIC_URL` (declared non-secret) | ALLOW (correct) |
| `echo $UNDECLARED_VAR` | ALLOW (correct) |
| `echo hello` | ALLOW (correct) |

PLAN §8.1 names only `echo $VAR`, so `printf` is beyond the literal spec text — hardening,
not a spec violation. Note the rule is inherently manifest-dependent: an undeclared
environment variable holding a real secret is not covered, which is by design.

---

## 7. What could not be tested, and why

| Item | Why not |
|---|---|
| **The page in a real browser** (§5.2 mechanics 3, 6, 10; CSP enforcement) | Requires a human at a browser — manual gate M1. This probe asserts the *headers and markup* are correct; it cannot prove Chrome enforces the CSP, that the reveal toggle works, or that the opener launches. The coordinator's M1 run is what surfaced the `Origin` bug, which is exactly the class of defect no socket-level probe finds. |
| **The user actually comparing the two nonces** (T9) | The anti-phishing control is human behaviour. The nonce is provably rendered in both places; whether a user checks it is unmeasurable here. |
| **Browser-extension DOM access** (PLAN §9.5) | Needs a real browser with an extension installed. |
| **A user approving an exfiltrating `env_use`** (PLAN §9.1) | Out of scope by PLAN §2.3. The confirmation callback was verified to fire with `networkEgress=true` and the full argv; the human decision is not testable. |
| **Same-uid `/proc/<pid>/environ`** (T6) | Out of scope by PLAN §2.3 / §9.3, and this is a Windows host — no `/proc`. |
| **Malicious harness reading stdio fds** (T4 principal / §9.4) | Out of scope by PLAN §2.3. |
| **Timing analysis of `timingSafeEqual`** | Statistical timing measurement is not reliable on a loaded Windows dev box. Instead the *structural* property was verified: the length guard short-circuits so the throwing path is unreachable, and the `catch` fails closed. |
| **Non-loopback binding on a multi-homed / IPv6-routable host** | Only one routable IPv4 interface was present. `::1` and that interface were both confirmed refused; a host with more interfaces was not available. |
| **Real DNS rebinding with a rebinding resolver** | Needs controlled DNS. The `Host`-header check is the actual mitigation and was attacked directly with 12 variants, which is the equivalent test at the layer the defence lives. |
| **`redirect: 'manual'` against a real allowlisted provider** | Would require an attacker-controlled open redirect on a genuine registry host. Reproduced faithfully with two local HTTPS servers and a throwaway CA instead. |
| **Linux / macOS behaviour** | Windows-only host (carried in as U9). Path handling, `Connection` semantics and `assertGitSafe`'s `git` invocations are platform-sensitive. |

---

## 8. Reproducing everything

```bash
pnpm -r build          # REQUIRED — dist/ is gitignored and may be stale or mutated
node scripts/probe-w3-loopback.mjs     # 153 pass / 1 fail  (the 1 is W3-01)
node scripts/probe-w3-http.mjs         #  79 pass / 0 fail
node scripts/probe-w3-probe.mjs        #  73 pass / 0 fail  (needs openssl on PATH)
node scripts/probe-w3-threats.mjs      #  13 mitigated / 1 partial (T3 = W3-02)
```

Regression check after the test changes in W3-03:

```
pnpm test            → exit code 0, zero "failed" across every package
packages/prompters   → 9 passed (was 7; +2 from W3-03)
```

Files changed by this workstream:

- `scripts/probe-w3-loopback.mjs` *(new)*
- `scripts/probe-w3-http.mjs` *(new)*
- `scripts/probe-w3-probe.mjs` *(new)*
- `scripts/probe-w3-threats.mjs` *(new)*
- `packages/prompters/test/loopback.test.ts` — one test renamed, two added (W3-03)
- `docs/verification/W3-red-team.md` *(this file)*

**No product code was modified.** W3-01 and W3-02 are reported with reproductions and
suggested fixes rather than patched, because both are in product source.
