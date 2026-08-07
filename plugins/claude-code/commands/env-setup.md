---
description: Prompt the user for every missing required key in a single pass.
allowed-tools: mcp__envseal-broker__*
model: default
---
Collect every missing required key in one pass:

1. Call `env_describe` to find which required keys are missing.
2. For each missing key, call `env_request` with the key name, then `env_await` to wait for the user's value.
3. When done, summarise which keys were stored and show each new salt fingerprint.

Only collect keys the project actually declares. Never print the values or prompt for keys that are already present.
