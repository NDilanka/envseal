# envseal — instructions for any coding agent

This repository uses envseal to provision secrets. The secret values must never
appear in this chat, in your tool output, in files you write, or in commands you
run. Follow these rules without exception.

## You must never

- Read, write, or copy the contents of any `.env` or `.env.*` file. (`.env.example`
  is the only exception: it holds placeholders, never values.)
- Run `printenv`, bare `env`, `export -p`, `set`, or `echo $VAR` / `echo $KEY...`
  to inspect or display environment variables.
- Use `cat`, `head`, `tail`, `less`, `grep`, `xxd`, `base64`, `sed`, or any other
  reader on a secrets file: `*.pem`, `*.key`, `id_rsa*`, `credentials.json`,
  `secrets.json` / `secrets.yaml` / `secrets.toml`, `.envseal/*`.
- Ask the user to paste an API key, token, or connection string into the chat.
- Echo an environment variable into a transcript, log, diff, or tool result.

## How to check which keys exist

```sh
envseal status          # human-readable
envseal status --json   # machine-readable; never contains values
```

Statuses are presence + metadata only (format-valid, length bucket, fingerprint,
last verified). There is no way to make envseal print a value.

## How to provision a missing key

```sh
envseal ensure          # prompts the user for every missing required key
envseal set KEY         # prompts for a single key
```

Never ask the user to add a key to `.env` and tell you about it. Run
`envseal ensure` instead, and wait for its exit code.

## How to run a command that needs secrets

```sh
envseal run -- <command...>
```

Secrets are injected only into that child process and its stdout/stderr are
redacted. Never run the command plain and never try to read the key yourself.

## How to verify a key actually works

```sh
envseal verify          # classified results: ok, auth_failed, rate_limited, ...
```

## How to ask the user what is wrong

```sh
envseal doctor          # project root, detected host + tier, gitignore, missing keys
```

## Exit codes (for scripts)

`0` ok · `1` required keys missing · `2` usage error · `3` cancelled ·
`4` no interactive surface · `5` sink failure · `6` verification failed.
Use them; never parse human text for secrets.