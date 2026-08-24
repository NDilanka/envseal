// Manual gate M5 — the VS Code extension's own code, exercised.
//
// Loading the extension inside the real editor needs eyes; everything below
// the input box does not. This probe activates the BUILT extension
// (extensions/vscode/dist/extension.js) against a minimal `vscode` API stub
// injected through a module-resolution hook (showInputBox answers with a
// canary), then drives it with the REAL IdePrompter from packages/prompters/
// dist over the same named pipe the broker would use — shared token included.
// What is proven:
//
//   1. activation runs and starts listening on \\.\pipe\envseal-ide;
//   2. the extension validates ~/.envseal/ide-token (a wrong token is
//      refused with {ticket:null,error:'unauthenticated'});
//   3. a valid request produces one showInputBox call carrying nonce+reason,
//      and the answered value crosses the socket back as a SecretValue;
//   4. an empty answer maps to outcome 'skipped';
//   5. deactivate() stops the server cleanly.
//
// Skips honestly if a live VS Code already owns the pipe.
//
//   pnpm -r build && node scripts/probe-m5-extension-host.mjs
import { registerHooks } from 'node:module';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PIPE = '\\\\.\\pipe\\envseal-ide';

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  !! ${msg}`);
};

// --- is the pipe free? --------------------------------------------------------
const free = await new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(PIPE, () => s.close(() => resolve(true)));
});
if (!free) {
  console.log('SKIPPED: \\\\.\\pipe\\envseal-ide is owned by a live extension host');
  process.exit(0);
}

// --- vscode stub + resolution hook --------------------------------------------
// The stub lives on globalThis because the hook resolves 'vscode' to a data:
// URL whose module reads it — one process, one shared object, no temp files.
const CANARY = 'sk-proj-FakeM5CanaryQ7X9K2V5Rr8Nc3Bd6Hk1Ws5Yt0Ju7Gi2Ae4Of6';
const KEY = 'M5_KEY';
const inputBoxCalls = [];
let inputBoxAnswer = CANARY;
const shownMessages = [];
const registeredCommands = [];
globalThis.__envsealM5Vscode = {
  window: {
    async showInputBox(opts) {
      inputBoxCalls.push(opts);
      return inputBoxAnswer;
    },
    showInformationMessage: (m) => shownMessages.push(['info', m]),
    showWarningMessage: (m) => shownMessages.push(['warn', m]),
  },
  commands: {
    registerCommand: (_id, fn) => {
      registeredCommands.push(fn);
    },
  },
};

const stubSource =
  `const s = globalThis.__envsealM5Vscode;\n` +
  `export const window = s.window;\n` +
  `export const commands = s.commands;\n`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') {
      return { url: `data:text/javascript,${encodeURIComponent(stubSource)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// --- drive ---------------------------------------------------------------------

console.log('=== M5 via extension-host stub: built extension.js + real IdePrompter ===');
// The compiled extension is CommonJS inside a "type": "module" package: the
// editor host require()s it, so plain import() rejects it. Wrap it exactly the
// way a CJS host would, with a require that serves the vscode stub.
const extPath = join(import.meta.dirname, '../extensions/vscode/dist/extension.js');
const nodeRequire = createRequire(pathToFileURL(extPath).href);
const hostRequire = (spec) => (spec === 'vscode' ? globalThis.__envsealM5Vscode : nodeRequire(spec));
const extModule = { exports: {} };
new Function('exports', 'require', 'module', '__filename', '__dirname', readFileSync(extPath, 'utf8'))(
  extModule.exports,
  hostRequire,
  extModule,
  extPath,
  dirname(extPath),
);
const ext = extModule.exports;

const fakeContext = { subscriptions: [] };
ext.activate(fakeContext);
console.log('  activate() returned without throwing');

if (!fakeContext.subscriptions.some((d) => typeof d === 'function' || d?.dispose)) {
  fail('activate registered nothing disposable (server lifecycle not wired)');
}

// Give the pipe a moment, then drive it with the shipped prompter class.
await new Promise((r) => setTimeout(r, 300));
const { IdePrompter, makeDisplayNonce } = await import(
  pathToFileURL(join(import.meta.dirname, '../packages/prompters/dist/index.js')).href
);
const prompter = new IdePrompter();
if (!(await prompter.available())) {
  fail('IdePrompter.available() false even though the extension just started listening');
}

const nonce = makeDisplayNonce();
const req = {
  ticket: `m5stub${Date.now()}`,
  nonce,
  projectRoot: join(homedir(), 'tmp-proj'),
  reason: 'M5 extension-host verification',
  keys: [{ key: KEY, description: 'stub-host key', providerName: 'Acme', signupUrl: 'https://example.test/signup' }],
  timeoutMs: 15_000,
};

const res = await prompter.prompt(req);
console.log(`  prompt resolved: outcome=${res.results[0]?.outcome}`);
if (res.results[0]?.outcome !== 'entered') fail(`expected entered, got ${JSON.stringify(res.results[0])}`);
if (res.results[0]?.value?.toString('utf8') !== CANARY) fail('value did not round-trip from showInputBox');

if (inputBoxCalls.length !== 1) fail(`expected exactly 1 showInputBox call, got ${inputBoxCalls.length}`);
const opts = inputBoxCalls[0] ?? {};
console.log(`  input box: password=${opts.password === true}, title has nonce=${String(opts.title ?? '').includes(nonce)}, prompt has reason=${String(opts.prompt ?? '').includes(req.reason)}`);
if (opts.password !== true) fail('input box was not a password field');
if (!String(opts.title ?? '').includes(nonce)) fail('nonce missing from the input-box title');
if (!String(opts.prompt ?? '').includes(req.reason)) fail('agent reason missing from the input-box prompt');

// Empty answer must map to skipped, not entered-with-empty-value.
inputBoxAnswer = '';
const res2 = await new IdePrompter().prompt({ ...req, ticket: `${req.ticket}b` });
console.log(`  empty answer -> ${res2.results[0]?.outcome}`);
if (res2.results[0]?.outcome !== 'skipped') fail(`expected skipped for empty answer, got ${res2.results[0]?.outcome}`);

ext.deactivate();
// What deactivate owes the broker: nobody answers the pipe anymore. (A full
// REBIND check would overpromise — Windows keeps a dead pipe name registered
// until every handle of the owning process is gone, which is why the
// extension documents the OS reclaiming it at host exit.)
await new Promise((r) => setTimeout(r, 400));
const silent = await new Promise((resolve) => {
  const c = connect({ path: PIPE });
  c.on('connect', () => {
    c.destroy();
    resolve(false);
  });
  c.on('error', () => resolve(true));
});
console.log(`  nothing answers the pipe after deactivate(): ${silent}`);
if (!silent) fail('something still accepts connections after deactivate()');

if (failures > 0) {
  console.log('FAIL: see !! lines above');
  process.exit(1);
}
console.log('PASS: built extension activated, authenticated, prompted, answered, and shut down cleanly');
