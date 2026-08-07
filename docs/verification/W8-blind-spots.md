# W8 — Blind-spot pass (cold read)

Method: fresh temp project (`$TMP/w8proj`, one `app.js` referencing `process.env.OPENAI_API_KEY`),
ran the documented CLI commands against `packages/cli/dist/bin.js`. Read README, VERIFICATION,
residual-risks, threat-model, and the relevant source. No files modified except this report.

---

## Ranked blind spots

### 1. Protection tier is reported from host *identity*, not from whether protection is *installed* — the tool overstates its own guarantee. **BLOCKS LAUNCH.**

`envseal doctor` and `init` in a bare temp directory — no `.claude/`, no plugin, no hooks, not
even a git repo — reported:

```
Host: Claude Code (Tier A)
  Found .claude/ directory or CLAUDECODE environment variable
  Tier A host with full protocol + interception hooks. Secrets are maximally protected.
```

Cause: `packages/cli/src/host.ts:27` — `if (existsSync(claudeDir) || process.env.CLAUDECODE)`
⇒ Tier A. `CLAUDECODE` is set for *any* process spawned inside a Claude Code session, including
sessions where the envseal plugin and its PreToolUse/UserPromptSubmit hooks are absent. The
"interception hooks" that define Tier A were never checked for.

Why it matters: the entire README frames tiers as the honest calibration mechanism, and
residual-risks.md itself says *"A tool that overstates its guarantees is worse than one that
makes none, because users calibrate their behavior to the claim."* This is that defect, in the
tool's own output. A user told "maximally protected" will paste-adjacent behave as if `.env`
reads are intercepted when nothing intercepts them. Doctor must verify the hooks are actually
registered (settings.json / plugin manifest present and loadable), and report Tier C otherwise.

### 2. `envseal run` — the Tier 4 core verb for shell-only agents — fails non-interactively with a false "user denied" message. **BLOCKS LAUNCH (High).**

```
$ node .../bin.js run -- node -e "console.log('x')"
Error: The user denied the confirmation.
exit 1
```

No confirmation was ever displayed (stdin is not a TTY). The command was harmless local `node`.
Tier 4's pitch is "an agent that can only shell out can still provision secrets safely" — but
agents shell out *without a TTY*, so `run` is unusable in exactly the context it exists for,
and it lies about why ("the user denied"). The agent will relay that message and the user will
believe they clicked something. Needs: non-TTY detection → a distinct error code (and a path to
pre-approval/allowlist), never "denied".

### 3. Non-interactive failure messages are opaque or absent (W7's "fail safe, never silently" does not hold at the CLI surface).

- `CI=1 envseal set OPENAI_API_KEY` → `Error: No outcome returned` (spec says
  `SEP_NO_INTERACTIVE_SURFACE`; this generic message reaches the user instead).
- `CI=1 envseal ensure` → `✗ Only 0/1 keys set`, exit 1, with **no reason given** — a newcomer
  in a devcontainer/SSH session sees a failure with zero explanation. This is the moment a
  first-time user gives up. Fix before launch.

### 4. Day-2 reality vs headline belief: protection covers the *provisioning moment*, not the key's life afterwards.

The README headline — "Your coding agent can ask for an API key without ever seeing it" — is
true of the protocol. But the value lands in plaintext `.env`, and on Tier B/C (which is 12 of
the 13 hosts in the "Works with any agent" table) nothing stops the agent reading `.env` with
its ordinary file tools on the very next turn — no hook, no confirmation, straight into the
transcript. The README's caveat mentions "leak-through-shell", which readers parse as "an
exotic exfiltration path", not "the agent will casually `cat .env` while debugging". A
reasonable reader believes the agent *can never see the key*; the true claim is "the key
doesn't transit the transcript during collection, and stays out afterwards only on Tier A with
hooks actually installed" (see #1). This is where a Hacker News reviewer lands first: *"So it
keeps the key out of chat for the 30 seconds of entry, then writes it to the exact file the
agent reads every day. On every host except one, this is a nicer UI for `.env`, not a security
boundary."* The steelman response exists (keychain sink + Tier A), but the README leads with
the strong claim and the default sink is dotenv. Fix: make the day-2 story explicit up front;
consider making keychain the recommended default on Tier B/C, since the docs already half-say
this.

### 5. residual-risks.md claims the loopback prompter is HTTPS; it is plain HTTP. (E8 violation, Medium.)

`docs/residual-risks.md:116`: "opens an HTTPS page at `127.0.0.1:<port>`".
`packages/prompters/src/loopback.ts:1,211`: `node:http`, URL `http://127.0.0.1:...`.
In a security doc this is exactly the kind of unearned guarantee the plan forbids. (HTTP on
loopback is defensible; claiming HTTPS is not.) Also invites the reviewer question: any
local process can watch `http://127.0.0.1` traffic via a proxy-configured browser or another
listener race — worth one honest paragraph.

### 6. The generated manifest ships a broken `$schema` reference.

`init` writes `"$schema": "./spec/sep-1/manifest.schema.json"` into the *user's* project, where
no `spec/` directory exists. Editors will flag it or silently no-op; either way the first file
envseal creates in a user's repo contains a dead link. Point it at a published URL or drop it.
Low/Medium; trivial fix, bad first impression.

### 7. Lifecycle is unaddressed: teams, rotation, monorepos, disagreement, uninstall.

No doc or code path answers:
- **Multi-developer teams:** `env.schema.jsonc` is presumably committed (it's the point), but
  there is no story for "teammate clones repo → what do they run, and how do they know?" —
  `ensure` is the answer but nothing (README quickstart aside) tells the *second* developer.
- **Rotation over time:** `env_revoke` reports a rotate URL, but nothing tracks key age or
  re-verifies stale keys; `last verified` exists in `env_describe` but no policy uses it.
- **Monorepos:** `--project` exists, but behaviour with several manifests in one repo (which
  broker, whose `.envseal/`, which `.env`) is unspecified.
- **Manifest ↔ `.env` disagreement:** keys present in `.env` but absent from the manifest are
  invisible to `status`/`describe`; keys removed from the manifest are never cleaned from the
  sink. Drift accumulates silently.
- **Uninstall / broker-is-broken:** no documented escape hatch telling a user "your secrets
  are just in `.env`/your keychain; here is how to leave". For a tool asking for trust, a
  clean exit story is part of the trust.

None of these block launch individually, but "what happens in month two" deserves one honest
docs page before open-sourcing.

---

## The four questions

**1. First ten minutes.** `--help`, `init`, `doctor`, `status` all work and are pleasantly
fast; `init`'s source scan and provider enrichment are genuinely good first impressions. The
give-up moment is the first *failure*: `ensure` in any non-interactive context prints
`✗ Only 0/1 keys set` with no reason (blind spot 3), and `run` claims the user denied a dialog
that never appeared (blind spot 2). Secondary friction: doctor says "Gitignore covers .env: no"
as a flat status line with no remediation hint, and the manifest's `$schema` is a dead path
(blind spot 6). Also note: my *user's own* security hooks blocked a shell command merely for
containing the string `SECRET_KEY` — expect envseal users inside Claude Code to hit similar
host-side friction that envseal's docs never mention.

**2. README belief vs code.** A reasonable reader believes (a) the agent can never see the
key — true only during collection, and afterwards only on Tier A with hooks installed (blind
spots 1, 4); (b) `doctor` tells them truthfully which tier they have — currently false (1);
(c) the input page is HTTPS — false (5); (d) Tier 4 makes it work for shell-only agents —
currently broken non-TTY (2). The hedges in residual-risks.md are excellent and honest; the
problem is the distance between the headline and the hedge, plus a tool output that actively
inflates the tier.

**3. Hostile reviewer.** The strongest correct attack is blind spot 4's framing: on most
hosts the end state is a plaintext `.env` the agent reads freely, so the security delta over
"type it into `.env` yourself" is (i) the transcript stays clean during entry and (ii) UX
niceties (validation, verify, rotate URLs). That delta is real but modest; the README sells it
as a trust architecture. Second attack: the tier system's honesty is undermined by its own
detector (1). Third: browser-based secret entry via an un-authenticated-origin HTTP page —
defended by nonce + single-use, but the docs claiming HTTPS hands the reviewer an easy hit.

**4. What nobody checked.** Everything in blind spot 7 — the project has been verified as an
*artifact* but not as something people *live with*: rotation, second developer, monorepo,
manifest/sink drift, uninstall, and what a user does when the broker itself misbehaves (the
only current answer is "edit `.env` by hand", which is fine but unstated). Also unexamined:
host-side security tooling (like my user's own hooks) interfering with envseal's commands.

---

## If I could only fix three things before launch

1. **Make `doctor`/`init` verify hooks are actually installed before claiming Tier A** — never
   print "maximally protected" from an env var (host.ts:27).
2. **Fix non-interactive behaviour of `run`/`set`/`ensure`:** correct error codes, real reasons,
   never "the user denied" when no prompt was shown.
3. **Rewrite the README's framing of the day-2 story:** state plainly that on Tier B/C a
   provisioned key in `.env` is readable by the agent thereafter, and lead users to keychain;
   fix the HTTPS claim in residual-risks.md in the same pass.
