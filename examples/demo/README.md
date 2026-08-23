# envseal demo project

A five-command walk through the whole lifecycle, from a project that reads one
secret to a child process that has it injected. Run it from this directory with
`envseal` on your PATH (or `node <repo>/packages/cli/dist/bin.js` in place of
`envseal` from a source checkout).

## 1. Declare — `envseal init`

Scans `src/` for environment-variable references and writes the manifest:

```sh
envseal init
```

`src/index.js` reads `process.env.DEMO_API_KEY`, so `env.schema.jsonc` comes
back declaring exactly that key, required, sink `dotenv`.

## 2. Gate — `envseal ensure --check`

Reports whether every required key is satisfied and exits 0 or 1. Never
prompts — this is the CI-safe check:

```sh
envseal ensure --check
```

Right after `init` it fails: nothing is stored yet.

## 3. Provision — `envseal set DEMO_API_KEY`

Opens the secure input surface (browser by default) and stores the value in
the declared sink. The value never appears in your shell or transcript:

```sh
envseal set DEMO_API_KEY
```

Now `envseal ensure --check` passes.

## 4. Run — `envseal run -- node src/index.js`

Injects the declared keys into the child environment only, after asking you
to confirm, and redacts the output:

```sh
envseal run -- node src/index.js
```

## 5. Status — `envseal status`

Read-only presence report, never values:

```sh
envseal status
```

## What CI does with this directory

`scripts/probe-example-demo.mjs` stages a copy of this project into a temp
directory and drives steps 1–5 against the built CLI with a stub prompter —
`ensure --check` failing before `set`, passing after, the run receiving the
value, and the sentinel value never appearing in any output. The CI job
`example-demo` runs it on every push, so the walk-through above cannot silently
rot.

## Verify (optional, needs a real key)

`envseal verify DEMO_API_KEY` probes the provider endpoint a key declares.
This demo's key is synthetic, so verify is not part of the loop; point the
manifest entry at a real provider format to exercise it.
