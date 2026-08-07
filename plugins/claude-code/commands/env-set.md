---
description: Set a single environment variable interactively.
argument-hint: <KEY>
allowed-tools: mcp__envseal-broker__*
model: default
---
Store a single key interactively:

1. Call `env_request` with the key `<KEY>`.
2. Call `env_await` and wait for the user's value.
3. Report whether the value was stored, skipped, cancelled, or rejected, plus the new fingerprint.

Never paste the key value back into the conversation — the broker stores it directly. If `<KEY>` is not declared, run `/env:setup` first.
