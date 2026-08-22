// Manual gate M1 re-check — the loopback consent page driven in the USER'S
// real Chrome through the kimi-webbridge daemon (http://127.0.0.1:10086),
// rather than a scripted HTTP client. This exercises what a scripted POST
// cannot: the page actually rendering (CSP, nonces, layout), the displayed
// nonce matching the agent-side nonce, and a native form submission carrying
// the CSRF token back to the single-use listener.
//
// Skips honestly (exit 0 with SKIPPED) when the daemon or its extension is
// not reachable — then the human runbook in VERIFICATION.md §5.1 applies.
//
//   node scripts/probe-m1-browser-bridge.mjs        (prompters must be built)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAEMON = 'http://127.0.0.1:10086/command';
const SESSION = 'envseal-consent-check';
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  !! ${msg}`);
};

async function bridge(action, args = {}) {
  const res = await fetch(DAEMON, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args, session: SESSION }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json();
  // The daemon wraps payloads: {ok, data:{...}} on success, {error} on failure.
  if (body?.ok && body.data) return body.data;
  return body;
}

// --- reachability ------------------------------------------------------------
try {
  const status = await fetch('http://127.0.0.1:10086/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list_tabs', args: {}, session: SESSION }),
    signal: AbortSignal.timeout(5_000),
  }).then((r) => r.json());
  if (status?.error) throw new Error(status.error);
} catch (e) {
  console.log(`SKIPPED: kimi-webbridge daemon not reachable (${e.message}); human runbook applies`);
  process.exit(0);
}

console.log('=== M1 via browser bridge: loopback consent page in real Chrome ===');
const { makeDisplayNonce } = await import(
  pathToFileURL(join(import.meta.dirname, '../packages/prompters/dist/index.js')).href
);
const { LoopbackPrompter } = await import(
  pathToFileURL(join(import.meta.dirname, '../packages/prompters/dist/index.js')).href
);

const KEY = 'M1_BRIDGE_KEY';
// Structurally realistic, deliberately fake.
const CANARY = 'sk-proj-FakeM1BridgeQ7X9K2V5Rr8Nc3Bd6Hk1Ws5Yt0Ju7Gi2Ae4Of6';
const nonce = makeDisplayNonce();
const root = mkdtempSync(join(tmpdir(), 'envseal-m1bridge-'));

let listenInfo = null;
const prompter = new LoopbackPrompter({
  openBrowser: false,
  onListening: (info) => {
    listenInfo = info;
  },
});

const request = {
  ticket: `m1bridge${Date.now()}`,
  nonce,
  surface: 'loopback-browser',
  keys: [{ key: KEY, description: 'browser bridge verification key' }],
  projectRoot: root,
  reason: 'M1 re-check via kimi web bridge',
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  userMessage: '',
};

const promptPromise = prompter.prompt(request);

// --- wait for the listener, then drive the page ------------------------------
const deadline = Date.now() + 30_000;
while (listenInfo === null && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
}
if (listenInfo === null) {
  fail('loopback listener never reported onListening');
  process.exit(1);
}
console.log(`  listener: ${listenInfo.url}`);

const nav = await bridge('navigate', {
  url: listenInfo.url,
  newTab: true,
  group_title: 'envseal consent verification',
});
if (!nav.success && !nav.tabId) {
  fail(`navigate failed: ${JSON.stringify(nav).slice(0, 200)}`);
  process.exit(1);
}

// The page must render with the nonce matching the one the agent side holds.
let snap = null;
for (let i = 0; i < 5; i += 1) {
  snap = await bridge('snapshot');
  if (snap?.tree && String(snap.tree).includes(nonce)) break;
  await new Promise((r) => setTimeout(r, 500));
}
const treeText = typeof snap?.tree === 'string' ? snap.tree : JSON.stringify(snap?.tree ?? []);
console.log(`  page renders nonce ${nonce}: ${treeText.includes(nonce)}`);
if (!treeText.includes(nonce)) {
  console.log(`  ---- snapshot head ----\n${treeText.slice(0, 600)}\n  ----`);
  fail('rendered page does not display the agent-side nonce (anti-phishing control broken)');
}
if (!treeText.includes(KEY)) fail('rendered page does not name the requested key');

// Fill the password field and submit through the bridge (synthetic activation
// still triggers the native form POST, which is what carries csrf+value).
const filled = await bridge('fill', { selector: 'input[type="password"]', value: CANARY });
if (!filled.success) fail(`fill failed: ${JSON.stringify(filled).slice(0, 150)}`);
const submitted = await bridge('click', { selector: 'input[type="submit"]' });
if (!submitted.success) fail(`submit click failed: ${JSON.stringify(submitted).slice(0, 150)}`);

// --- the prompter must resolve with exactly what was typed --------------------
const result = await Promise.race([
  promptPromise,
  new Promise((resolve) => setTimeout(() => resolve(null), 20_000)),
]);
if (result === null) {
  fail('prompt did not resolve after submit');
} else {
  const r0 = result.results[0];
  console.log(
    `  outcome=${r0.outcome} valueMatches=${r0.value?.toString('utf8') === CANARY}`,
  );
  if (r0.outcome !== 'entered') fail(`expected entered, got ${r0.outcome}`);
  if (r0.value?.toString('utf8') !== CANARY) fail('round-tripped value differs from what was typed');
}

// --- single-use: the port must refuse everyone now ---------------------------
await new Promise((r) => setTimeout(r, 300));
let refused = false;
try {
  await fetch(listenInfo.url, { signal: AbortSignal.timeout(5_000) });
} catch {
  refused = true;
}
console.log(`  second connection refused: ${refused}`);
if (!refused) fail('listener still accepting connections after successful submission');

rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log('FAIL: see !! lines above (tab left open in the envseal-consent-check group)');
  process.exit(1);
}
console.log('PASS: page rendered in real Chrome, nonce matched, canary round-tripped, port closed');
