# envseal

**Your coding agent can ask for an API key without ever seeing it.**

envseal is a protocol (SEP/1) and local broker for safely provisioning secrets to AI coding agents. The agent declares what it needs, the user provides it through a secure local interface, and the value is written to `.env` or a keychain — never passed through the model's transcript.

## The problem

When an AI agent needs an API key, the standard flow is: "Please add `OPENAI_API_KEY=sk-...` to your `.env` and let me know." This forces a choice:

- **Paste into chat:** The key is now in the conversation transcript. That transcript is sent to the model provider, retained in server logs, persisted to session files, and replayed into context on every subsequent turn. One paste produces an unbounded number of copies across systems the user does not control. The key must be rotated immediately, and most users do not realize this.
- **Edit by hand:** Safe, but the agent loses the thread. It cannot confirm the key was actually added, validate its format, verify it works, or guide the user to the right provider.

There is currently no standard mechanism for an agent to say *"I need a value I am not allowed to see"* and have that resolve safely.

## How it works

The protocol splits the problem into four principals, each with a specific trust level:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  MODEL  (untrusted for values)                                           │
│    tools: env_describe · env_declare · env_request · env_await            │
│           env_verify · env_use · env_revoke                              │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │  MCP / JSON-RPC   (names, tickets, redacted status)
                              │  ✗ never carries a secret value
┌─────────────────────────────┴────────────────────────────────────────────┐
│  HARNESS  (Claude Code / Codex / Cursor / Zed / Cline)                    │
│    + hooks (Claude Code only):  PreToolUse guard · prompt redactor        │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │  spawns (stdio)
┌─────────────────────────────┴────────────────────────────────────────────┐
│  BROKER  (trusted)                                                        │
│  ┌────────────┐ ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌───────────┐ │
│  │ Manifest   │ │ Ticket      │ │ Prompter │ │ Validator │ │ Redactor  │ │
│  │ engine     │ │ store       │ │ registry │ │ + probes  │ │ (egress)  │ │
│  └────────────┘ └─────────────┘ └────┬─────┘ └───────────┘ └───────────┘ │
│  ┌──────────────────────────────┐    │        ┌──────────────────────┐   │
│  │ Sink registry                │    │        │ Audit log (JSONL)    │   │
│  │  dotenv · keychain* · sops†  │    │        │ names only, no values│   │
│  │  1password†·doppler†·vault†  │    │        └──────────────────────┘   │
│  └──────────────────────────────┘    │                                   │
└──────────────────────────────────────┼───────────────────────────────────┘
                                       │  ▲ the ONLY path a value travels
              ┌────────────────────────┴──────────────────────────┐
              │  PROMPTER ADAPTERS (secure input surfaces)         │
              │   1. loopback-browser   (default, cross-platform)  │
              │   2. native-dialog    (osascript/PowerShell/zenity)│
              │   3. ide                (VS Code showInputBox)     │
              │   4. tty                (direct /dev/tty, CONIN$)  │
              │   5. none                (CI → hard fail)          │
              └────────────────────────┬──────────────────────────┘
                                       │
                                     ┌──┴──┐
                                     │USER │
                                     └─────┘
```

`*` keychain is write-only today (a stored value cannot yet be read back). `†` declared in the schema but not implemented — these sinks throw `SEP_SINK_UNAVAILABLE`. Only `dotenv` both stores and resolves values.

**The one rule:** The secret value travels `User → secure input surface → broker → sink (.env / keychain / vault)` and crosses no other boundary. Of the declared sinks, only `dotenv` and `keychain` accept values today, and `keychain` is write-only (see the legend above). The model and harness can only see key names, declarations, tickets, and redacted status metadata.

The agent's verbs are strictly declarative:
- **`env_declare`** — "This project needs `OPENAI_API_KEY`, here's the format and provider."
- **`env_request`** — "Please collect these keys from the user."
- **`env_await`** — "When the user is done, tell me the outcome (stored, cancelled, invalid format)."
- **`env_verify`** — "Test the key by making a network call to the provider."
- **`env_use`** — "Run this command with the keys injected."

The model never constructs a value, never reads one back, and cannot receive one. Safety is structural, not policed.

> The hooks row applies to **Claude Code only**. Every other host gets the
> protocol (the model still cannot see a value), but nothing intercepts a shell
> command that reads `.env`. `envseal doctor` reports the real tier for your
> host — and reports tier B, not A, when the Claude Code plugin is not actually
> installed.

## Install

Not yet published to npm. Build from source:

```bash
git clone <this-repo> && cd envseal
pnpm install && pnpm build

# then, from your own project:
node /path/to/envseal/packages/cli/dist/bin.js init
node /path/to/envseal/packages/cli/dist/bin.js ensure
```

Once published, this becomes `pnpm add -D @envseal/cli` and `npx envseal init`.

`init` scans your source for environment-variable references and writes `env.schema.jsonc`, filling in provider metadata for keys it recognises. `ensure` then prompts for anything missing, in one pass. Values go to `.env` by default (after checking `.gitignore` covers it and git is not already tracking it), or to your OS keychain with `sink: "keychain"` — note the keychain sink is write-only today: it stores the value, but `envseal run` cannot yet resolve a keychain-stored value back, so use dotenv if the command needs the value.

## Works with any agent

One protocol, four independent transport bindings. A host needs only one:

| Tier | Transport | Hosts | Requirement |
|---|---|---|---|
| **1. MCP** | stdio only (HTTP is a separate binding: `@envseal/http-server`, which speaks REST + OpenAPI, not MCP) | Claude Code, Codex, Cursor, Windsurf, Cline, Roo, Zed, Continue, Amp, Goose, Kilo, JetBrains AI, Copilot Agent (MCP), OpenAI Agents SDK, LangGraph/CrewAI via MCP client | MCP tool calling |
| **2. Native SDK** | in-process import or HTTP | Any agent on OpenAI, Anthropic, Gemini, Bedrock SDKs; LangChain, LlamaIndex, Vercel AI SDK | Register a tool |
| **3. Local HTTP** | `127.0.0.1` REST + token auth | Agents in Python, Go, Rust, or any language that can HTTP | Make an HTTP request |
| **4. CLI** | `envseal` subcommands, JSON output, exit codes | Any agent (Aider, OpenHands, bash loops, shell-only runners) | Run a command |

Tier 4 makes the claim "works with any agent" true rather than aspirational: an agent that can only shell out can still provision secrets safely.

## Protection tiers

envseal offers different levels of protection depending on your host. `envseal doctor` reports which tier you have:

- **Tier A** — Full protocol + interception hooks. Claude Code **with the envseal plugin installed**. Model tool calls and user messages are pre-filtered to prevent accidental exfiltration. **Recommended.** Running under Claude Code without the plugin reports tier B, not A — `doctor` checks for the hook wiring rather than assuming it.
- **Tier B** — Protocol + advisory guardrails (rules files, pre-commit hooks, Continue contexts). Leak-through-shell is possible; recommend the `keychain` sink so `.env` holds only references — once keychain read-back ships; today keychain is write-only, so dotenv is the only sink `envseal run` can resolve.
- **Tier C** — Protocol only. Same recommendation, stated more plainly.

**On Tier B and C, a shell command can still exfiltrate a value.** The broker requires confirmation for every command and adds a network egress warning when the command can reach the network, but a user who clicks through defeats the control. This is not a limitation of the system; it is inherent to any tool that lets an agent execute arbitrary code. envseal's guarantees are structural at the protocol level — the model cannot obtain a value through the protocol itself — but the user remains responsible for what code they approve.

## What the model can and cannot do

The seven tools:

1. **`env_describe()`** — Read-only status of all keys (present/missing, format-valid, last verified). Never returns values. No flag or debug mode makes it do so.
2. **`env_declare(entries)`** — Tell the broker which keys the project needs, with format validation and provider metadata. Input is strictly rejected if it contains a value-shaped field.
3. **`env_request(keys, reason)`** — Ask the user to provide the named keys via a secure browser or native dialog. Returns immediately with a ticket ID and nonce.
4. **`env_await(ticket)`** — Block up to 90 seconds for the user to finish. Returns per-key outcome (stored, skipped, cancelled, invalid_format, verify_failed, timeout).
5. **`env_verify(keys)`** — Test a key by calling the provider's authentication endpoint. Returns classified result (ok, auth_failed, rate_limited, etc.) without showing upstream response bodies.
6. **`env_use(keys, command)`** — Run a shell command with the keys injected into child environment only. stdout/stderr are redacted. Every command requires confirmation; commands with detected network egress add an explicit warning on top.
7. **`env_revoke(key)`** — Remove a key from the sink and report the provider's rotation URL so the model can tell the user where to invalidate it.

**There is no tool, flag, debug mode, or environment variable that returns a secret value from any of these operations.** Not in normal mode, verbose mode, dry-run, or in error paths.

This holds by construction rather than by convention: the model's verbs are declarative, so there is no operation whose result type carries a value. It is checked rather than assumed — a test spawns the real MCP server as a child process, drives a full provisioning flow over stdio, records every byte in both directions including stderr, and asserts a sentinel secret appears nowhere while the flow demonstrably completed. Types alone are not the guarantee; during development this codebase typechecked cleanly while shipping a server that could not start.

## Security

- **[SECURITY.md](SECURITY.md)** — Supported versions and vulnerability reporting.
- **[docs/threat-model.md](docs/threat-model.md)** — Detailed threat and mitigation analysis.
- **[docs/residual-risks.md](docs/residual-risks.md)** — Seven risks that remain even with the protocol in place.

Read the residual risks section. No tool that handles secrets is risk-free, and this one makes no exceptions for marketing.

## Status

**Pre-1.0.** The protocol is complete and implemented. The design is stable. Feedback on the API surface, host integrations, and threat model is wanted. Expect the protocol to remain compatible once 1.0 ships; minor schema additions will follow the semver policy.

## License

Apache-2.0. See [LICENSE](LICENSE).
