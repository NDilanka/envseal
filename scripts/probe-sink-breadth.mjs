// Probe — sink breadth across every declared sink, end to end.
//
// Four provider-CLI sinks (vault, onepassword, doppler, sops) joined dotenv
// and keychain, and the surfaces that talk about sinks grew around them.
// This probe checks the whole family against the contract every sink is held
// to, straight through the built packages a customer imports:
//
//   1. the registry declares exactly the six real sinks plus the `external`
//      placeholder — wiring drift shows up here before anything else;
//   2. every sink answers available();
//   3. an UNAVAILABLE sink refuses every operation with SEP_SINK_UNAVAILABLE,
//      and the message names the missing prerequisite (which CLI, which
//      credential) instead of a vague "sink unavailable";
//   4. an AVAILABLE sink completes a store/read/revoke round-trip: write()
//      then read() recovers the exact bytes, remove() reports true, a
//      following read() reports null (absence, never an error) and a second
//      remove() reports false.
//
// Values never reach the output: results print as booleans and lengths only.
//
//   pnpm -r build && node scripts/probe-sink-breadth.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const coreUrl = pathToFileURL(join(import.meta.dirname, '../packages/core/dist/index.js')).href;
const protocolUrl = pathToFileURL(join(import.meta.dirname, '../packages/protocol/dist/index.js')).href;

// Structurally realistic, deliberately fake — same posture as probe-m3-keychain.
const CANARY = 'sk-proj-FakeBreadthQ7X9K2V5Rr8Nc3Bd6Hk1Ws5Yt0Ju7Gi2Ae4Of6';
const KEY = 'PROBE_SINK_BREADTH_KEY';

/**
 * What each sink's refusal must name when its prerequisite is missing, taken
 * from the unavailableReason() strings the adapters ship. A refusal that
 * matches the CODE but not its cause would send users hunting in the wrong
 * place, so both halves are asserted.
 */
const PREREQUISITE_HINTS = {
  vault: /vault CLI|VAULT_ADDR/,
  onepassword: /\bop CLI\b|1Password/,
  doppler: /doppler CLI|DOPPLER_TOKEN|doppler configure/i,
  sops: /sops CLI|\.sops\.yaml|SOPS_AGE_KEY_FILE/,
  keychain: /security|secret-tool|credential store/,
  dotenv: /dotenv/,
};

const { getSink, allSinks, projectPaths } = await import(coreUrl);
const { asSecret, SepError } = await import(protocolUrl);

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  !! ${msg}`);
};

console.log('=== registry declares exactly the six sinks plus the external placeholder ===');
{
  const ids = allSinks().map((s) => s.id).sort();
  const expected = ['doppler', 'dotenv', 'external', 'keychain', 'onepassword', 'sops', 'vault'];
  console.log(`  registered: ${ids.join(', ')}`);
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    fail(`registry ids drifted: expected [${expected.join(', ')}]`);
  }
}

console.log('=== available() + refuse-or-round-trip per sink ===');
for (const id of ['dotenv', 'keychain', 'vault', 'onepassword', 'doppler', 'sops']) {
  const sink = getSink(id);
  const root = mkdtempSync(join(tmpdir(), `envseal-sink-${id}-`));
  const paths = projectPaths(root);

  let available;
  try {
    available = await sink.available(paths);
  } catch (error) {
    fail(`${id}: available() threw instead of degrading to false: ${error.message}`);
    rmSync(root, { recursive: true, force: true });
    continue;
  }
  // available() is a liveness probe, never a thrower: a missing provider CLI
  // degrades to false so callers can route around the sink.
  if (typeof available !== 'boolean') {
    fail(`${id}: available() returned ${typeof available}, expected boolean`);
  }

  if (!available) {
    const refusals = [];
    for (const operation of ['read', 'write', 'remove']) {
      try {
        if (operation === 'read') await sink.read(paths, KEY);
        else if (operation === 'write') await sink.write(paths, KEY, asSecret(Buffer.from(CANARY, 'utf8')));
        else await sink.remove(paths, KEY);
        refusals.push(`${operation} did not throw`);
      } catch (error) {
        if (!(error instanceof SepError)) {
          refusals.push(`${operation} threw non-SepError (${error.constructor.name})`);
          continue;
        }
        if (error.code !== 'SEP_SINK_UNAVAILABLE') {
          refusals.push(`${operation} threw ${error.code}`);
          continue;
        }
        const hint = PREREQUISITE_HINTS[id];
        if (!hint.test(error.userMessage)) {
          refusals.push(`${operation} message does not name the prerequisite: "${error.userMessage}"`);
        }
      }
    }
    if (refusals.length > 0) {
      for (const r of refusals) fail(`${id}: ${r}`);
    } else {
      console.log(`  ${id}: available=false -> read/write/remove refuse with SEP_SINK_UNAVAILABLE naming the prerequisite`);
    }
  } else {
    let storedOk = false;
    let readBack = null;
    let removed = null;
    let absentAfterRemove = undefined;
    let removedTwice = undefined;
    let opError = null;
    try {
      await sink.write(paths, KEY, asSecret(Buffer.from(CANARY, 'utf8')));
      storedOk = true;
      readBack = await sink.read(paths, KEY);
      removed = await sink.remove(paths, KEY);
      absentAfterRemove = await sink.read(paths, KEY);
      removedTwice = await sink.remove(paths, KEY);
    } catch (error) {
      opError = error;
    }

    if (opError) {
      fail(`${id}: round-trip failed at an operation: ${opError.message}`);
    } else if (!storedOk) {
      fail(`${id}: write() completed without storing (no error, no value)`);
    } else if (!(readBack instanceof Buffer && readBack.equals(Buffer.from(CANARY, 'utf8')))) {
      fail(`${id}: read() did not recover the stored bytes (got ${readBack === null ? 'null' : `${readBack?.length ?? '?'} bytes`})`);
    } else if (removed !== true) {
      fail(`${id}: remove() reported ${removed}, expected true`);
    } else if (absentAfterRemove !== null) {
      fail(`${id}: read() after remove returned ${absentAfterRemove === undefined ? 'threw' : JSON.stringify(absentAfterRemove)}, expected null`);
    } else if (removedTwice !== false) {
      fail(`${id}: second remove() reported ${removedTwice}, expected false`);
    } else {
      console.log(`  ${id}: available=true -> store/read/revoke round-trip ok (${Buffer.byteLength(CANARY)} bytes recovered, absence reads as null)`);
    }
  }

  rmSync(root, { recursive: true, force: true });
  // Defensive: if a keychain round-trip died mid-way the DPAPI blob outlives
  // the temp root it was scoped by.
  const strayBlob = join(process.env.LOCALAPPDATA ?? '', 'envseal', 'creds', KEY);
  if (existsSync(strayBlob)) {
    try {
      rmSync(strayBlob, { force: true });
      console.log(`  cleaned up stray credential ${strayBlob}`);
    } catch {
      console.log(`NOTE: could not remove ${strayBlob}`);
    }
  }
}

if (failures > 0) {
  console.log(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('PASS: all six sinks answer available() and either refuse with a named prerequisite or complete a full store/read/revoke round-trip');
