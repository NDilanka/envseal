---
description: List all declared environment variables, their presence status, and fingerprints.
allowed-tools: mcp__envseal-broker__*
model: default
---
List every key declared in the project manifest (`env.schema.jsonc`) with its status:

1. Call `env_describe` (no arguments).
2. For each key, report: name, presence, sink, length bucket, fingerprint, and last-verified date (if any).
3. If a required key is missing, recommend `/env:setup` to collect it.

Never read `.env` or any other secret file directly — `env_describe` already reports presence and status. Never print secret values; fingerprints are salted and safe to show.
