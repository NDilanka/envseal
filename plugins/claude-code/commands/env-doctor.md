---
description: Audit provisioning health — gitignore coverage, tracked secrets, file permissions.
allowed-tools: Bash
model: default
---
Audit the project's secret-handling health with read-only diagnostics only:

1. Check `.env*` is covered by `.gitignore` (`git check-ignore .env`), and confirm no `.env` (or `.envseal/*`) file is tracked (`git ls-files`).
2. Report `.env`, `.envseal/`, and any `*.pem` / `*.key` file permissions.
3. Confirm `env.schema.jsonc` exists and the manifest parses.

Suggest concrete fixes for anything found (e.g. "add `.env` to `.gitignore` then `git rm --cached .env`"). Run only read-only commands — never `cat`, `printenv`, or anything that prints credential contents.
