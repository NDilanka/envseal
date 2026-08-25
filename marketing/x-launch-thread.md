# envseal — X Launch Thread Drafts (2026-08-25)

Three variants below. All facts verified against the shipped v0.1.2.
Attach: `marketing/launch-video/out/envseal-launch-1080p.mp4` (34s, 1080p, 2.9MB).
Pick ONE; don't mix. Character counts include spaces.

---

## Variant A — "The paste" (story-led, recommended)

**1/**

Your AI agent needs an API key.

So you paste it into the chat.

Now it lives in the transcript forever — sent to a provider, stored in
logs, replayed into context on every turn.

We built envseal to end that. 🧵 [video]

**2/**

The flow is simple:

`npx envseal init` → envseal scans your source and writes
`env.schema.jsonc`.

When your agent says "I need OPENAI_API_KEY", envseal opens a secure
page on YOUR machine. You type the key there.

The agent only ever sees: `{"outcome": "stored"}`

**3/**

Then the agent runs its command with the real value injected — and here's
the part I love:

anything the child process prints comes back redacted:

`KEY=«redacted:OPENAI_API_KEY»` · redactedCount: 1

The secret never crosses the line. That frame is in the video. ⤴

**4/**

Under the hood:
- 9 npm packages, SLSA-provenance attested on every tarball
- MCP-native + CLI/SDK/local-HTTP bindings
- .env or OS keychain sink
- Claude Code plugin blocks `cat .env` style reads before they happen
- MIT-of-trust: zero-knowledge of your values by design

**5/**

Try it:

```
npm install -D @envseal/cli
npx envseal init
```

Repo + full threat model: github.com/NDilanka/envseal

Secrets stay yours.

---

## Variant B — "Show, don't tell" (minimal, video-first)

**1/**

Your coding agent can ask for an API key without ever seeing it.

envseal: a local broker for AI agents that need secrets they're not
allowed to read. 34 seconds: [video]

**2/**

What happens when an agent runs with secrets injected?

It prints them. They always leak.

With envseal the transcript gets:

`KEY=«redacted:OPENAI_API_KEY»`

Not the key. Ever.

**3/**

Works where you already work — Claude Code, Cursor, Codex, Cline,
Zed, Windsurf + shell-only agents via CLI.

```
npm install -D @envseal/cli
```

github.com/NDilanka/envseal

---

## Variant C — "Security engineer voice" (technical audience)

**1/**

Shipping an agent that touches credentials?

Threat model it for 30 seconds:
- prompt injection → exfil via tool args
- pasted keys → permanent transcript copies
- child processes → stdout leaks

envseal (open source, Apache-2.0) addresses all three at the protocol
level. [video]

**2/**

Design: the model requests a key by NAME. The broker mints a nonce'd
ticket and opens a local page. You type the value there. The model's
allowable universe is {key name, outcome} — values are structurally
absent, not policy-blocked.

**3/**

Defense-in-depth beyond the protocol:
- secret-shaped strings in declarations → rejected before persist
- egress redaction on child stdout/stderr (verified vs raw/base64/hex/
  url-encoded/10MB-noise adversarial cases)
- PreToolUse hook denies `cat .env`, `rg KEY .env`, `$(<.env)`…
- audit log records events, never values
- SLSA provenance on every published tarball

Full campaign: ~55 adversarial scenarios, report in repo.

**4/**

```
npm install -D @envseal/cli
npx envseal init
```

github.com/NDilanka/envseal

Apache-2.0. Feedback on the threat model wanted.

---

## Posting notes
- Attach the video to post 1 only; X downranks multi-video threads.
- Best window for dev-audience: Tue–Thu, 9–11am US Eastern.
- Reply to yourself with the README link + one screenshot of the secure
  browser prompt (frame ~14s) as follow-up engagement bait.
- Do NOT use $CASHTAG-style hashtags (#devtools etc.) — organic reach is
  better without them; the word "open source" does the targeting.
