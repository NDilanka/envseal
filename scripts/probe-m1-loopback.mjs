// Manual gate M1, automated with a real browser.
//
// Stands up the REAL loopback prompter, prints its URL and display nonce, then
// waits for a browser to submit. It never prints the value it receives — only
// whether that value matched the sentinel the driver typed in.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// NOTE: LoopbackPrompter is not re-exported from the package index (only
// selectPrompter/allPrompters are), so a consumer cannot construct it with
// options. Deep import here; filed as a finding.
import { LoopbackPrompter } from '../packages/prompters/dist/loopback.js';
import { makeDisplayNonce } from '../packages/prompters/dist/index.js';

const SENTINEL = 'sk-M1SENTINEL0000000000000000000000';

const root = mkdtempSync(join(tmpdir(), 'envseal-m1-'));
writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');

const nonce = makeDisplayNonce();

// A reason carrying an injection payload: the page must escape it. The unit
// test asserts this against a string; here a real browser renders it.
const reason = 'Need the key for <script>alert(1)</script> deployment';

const prompter = new LoopbackPrompter({
  // Do not let the platform opener race the driver; we navigate deliberately.
  openBrowser: false,
  onListening: ({ url, port }) => {
    console.log(`M1_URL ${url}`);
    console.log(`M1_PORT ${port}`);
    console.log(`M1_NONCE ${nonce}`);
  },
});

const outcome = await prompter.prompt({
  ticket: 'tkt_m1_probe',
  nonce,
  projectRoot: root,
  reason,
  timeoutMs: 240_000,
  keys: [
    {
      key: 'OPENAI_API_KEY',
      description: 'Used by src/llm/client.ts for chat completions.',
      providerName: 'OpenAI',
      signupUrl: 'https://platform.openai.com/api-keys',
      formatHint: 'starts with sk-',
    },
  ],
});

const entered = outcome.results.find((r) => r.outcome === 'entered');
console.log(
  'M1_RESULT ' +
    JSON.stringify({
      outcomes: outcome.results.map((r) => ({ key: r.key, outcome: r.outcome })),
      // Never print the value itself — only whether it round-tripped intact.
      matchedSentinel:
        entered && 'value' in entered ? entered.value.toString('utf8') === SENTINEL : false,
    }),
);

rmSync(root, { recursive: true, force: true });
