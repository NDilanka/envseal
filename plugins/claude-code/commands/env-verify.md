---
description: Verify each stored credential against its provider endpoint.
allowed-tools: mcp__envseal-broker__*
model: default
---
Run verification probes on stored credentials:

1. Call `env_verify` for each stored key listed by `env_describe`.
2. Present the classified result for each key: ok, auth_failed, forbidden, rate_limited, network_error, no_probe, or probe_not_approved.
3. Flag `auth_failed` / `forbidden` results as likely expired or revoked keys and recommend `/env:rotate <KEY>`.

Never print raw provider responses or secret values; `env_verify` returns only sanitised, classified results.
