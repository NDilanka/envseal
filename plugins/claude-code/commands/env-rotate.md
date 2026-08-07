---
description: Revoke a key and show the provider's rotation URL.
argument-hint: <KEY>
allowed-tools: mcp__envseal-broker__*
model: default
---
Revoke and rotate a specific key:

1. Call `env_revoke` with the key `<KEY>`.
2. If the result includes a `rotateUrl`, show it and tell the user to rotate the credential there, then re-store via `/env:set <KEY>`.
3. If no `rotateUrl` is known, tell the user to rotate it at the provider's console.

Never print the key value. Revoking is destructive — confirm with the user before calling `env_revoke`.
