/**
 * Advisory Cursor rule file shipped by `envseal init`.
 *
 * Keep this string identical to `plugins/cursor/rules/envseal.mdc`. The
 * cursor-wiring test fails if they drift. Embedding (not reading plugins/ at
 * runtime) is what makes published `@envseal/cli` able to write the file.
 */
export const CURSOR_RULES_MDC = `---
description: envseal — never read .env, never echo secrets; use env_describe/env_request instead.
alwaysApply: true
---

Cursor rules are advisory, not enforced. Treat these as hard rules regardless.

- Never read, write, or print the contents of \`.env\` or any \`.env.*\` file (\`.env.example\` is the only exception — it contains placeholders, never values).
- Never run \`printenv\`, bare \`env\`, \`export -p\`, \`set\`, \`env | grep ...\`, or \`echo $VAR\` / \`echo $KEY...\` to inspect or display environment variables. Every one of these puts secret values into the transcript.
- Never \`cat\`, \`head\`, \`tail\`, \`less\`, \`grep\`, \`xxd\`, or \`base64\` a secrets file (\`*.pem\`, \`*.key\`, \`credentials.json\`, \`secrets.json\`, \`.envseal/*\`).
- Never ask the user to paste an API key into the chat.

Instead, use the envseal broker via MCP:

- \`env_describe\` — read-only status of the declared keys (present, format-valid, last verified). It never returns values and there is no way to make it do so.
- \`env_request\` — collect the missing keys from the user through a secure prompt. It returns a ticket, never a value; follow up with \`env_await\`.
- \`env_declare\` — declare a key this project needs, with format and provider metadata.
- \`env_verify\` — test that a key actually works (classified result only).
- \`env_use\` — run a command with secrets injected into the child process; output is redacted.
- \`env_revoke\` — remove a key and get the rotation URL.

If a required key is missing, \`env_request\` it. Never read \`.env\` to find it, and never print it back.
`;
