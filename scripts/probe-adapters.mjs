// Manual probe: which real prompters and sinks are actually usable on this
// machine. Not a test — a one-shot reality check that the adapters load and
// report availability without throwing.
import { allPrompters, selectPrompter } from '../packages/prompters/dist/index.js';
import { allSinks } from '../packages/core/dist/index.js';
import { projectPaths } from '../packages/core/dist/index.js';

console.log(`--- prompters on ${process.platform} ---`);
for (const p of allPrompters()) {
  let ok;
  try {
    ok = await p.available();
  } catch (e) {
    ok = `THREW: ${e.message}`;
  }
  console.log(`  ${p.id.padEnd(18)} available=${ok}`);
}
const chosen = await selectPrompter();
console.log(`  selectPrompter() -> ${chosen.id}`);

console.log('--- sinks ---');
const paths = projectPaths(process.cwd());
for (const s of allSinks()) {
  let ok;
  try {
    ok = await s.available(paths);
  } catch (e) {
    ok = `THREW: ${e.message}`;
  }
  console.log(`  ${s.id.padEnd(14)} available=${ok}`);
}
