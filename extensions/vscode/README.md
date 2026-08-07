# envseal-vscode — `ide` prompter surface

Registers a per-user socket that the envseal broker uses to ask the user for
secret values through a real VS Code input box
(`window.showInputBox({ password: true, ignoreFocusOut: true })`) — the highest
quality input surface SEP/1 knows.

## What it does

1. On activation it creates (if absent) `~/.envseal/ide-token` —
   **32 random hex bytes, mode 0600**.
2. It listens on a per-user socket: `~/.envseal/ide.sock` on POSIX, or
   `\\.\pipe\envseal-ide` on Windows.
3. For each incoming request line it verifies the token, then prompts one key at
   a time with `showInputBox`, showing the **nonce** and the agent's **verbatim
   reason** so the user can confirm the request really came from this agent
   session (the anti-phishing control for the IDE surface).
4. It replies with one JSON line: `{ ticket, results: [{ key, outcome,
   value? }] }`, where outcome is `entered`, `skipped`, or `cancelled`.

The value travels `user → input box → broker socket` and nowhere else. It is
never written to disk, never logged, and never sent to the model.

## Why the token exists

An unauthenticated socket would let *any* local process register itself as the
prompter and either harvest prompt contents (phishing the user with a fake
request) or forge result messages back to the broker. The token in
`~/.envseal/ide-token` (0600, read by both the broker and the extension)
authenticates each request; the extension compares it with
`crypto.timingSafeEqual` and refuses connections without it.

Broker-side counterpart: `packages/prompters/src/ide.ts` (the `ide` prompter
adapter) speaks the same line protocol. It must include the token on each
prompt request line.

## Build

```sh
pnpm --filter envseal-vscode build   # tsc -p tsconfig.json → dist/extension.js
pnpm --filter envseal-vscode typecheck
```

TypeScript strict, ESM (`NodeNext`), no runtime dependencies — only
`@types/vscode` as a dev dependency; `vscode` itself is never an npm package.

## Runtime note

This extension uses the ESM loader, which needs a current daily/stable VS Code
desktop build (the ESM-sandboxed extension host). The `engines.vscode`
`^1.85.0` range is the floor for the API surface used; if your VS Code cannot
load ESM extensions, update VS Code first.

## Installing the built extension

```sh
pnpm --filter envseal-vscode build
code --install-extension ./extensions/vscode   # points at package.json
```

After activation, `Developer: Show Running Extensions` lists `envseal-vscode`.
The `envseal.provideSecret` command is a smoke test — it confirms activation —
the real traffic arrives from the broker over the socket.