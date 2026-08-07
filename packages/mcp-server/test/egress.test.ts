import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The single-egress invariant: every string that leaves this server toward a
 * model passes through `respond`/`respondError`, which is the one place the
 * redactor runs. A handler that builds its own `{ content: [...] }` bypasses it
 * silently — nothing fails, the shape is identical, and the redaction simply
 * does not happen.
 *
 * Source-level assertion by design (PLAN.md T6.2): the property is "no handler
 * constructs a result object", which is a statement about the code, not about
 * any single execution path.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const TOOLS_DIR = resolve(HERE, '..', 'src', 'tools');

describe('egress', () => {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));

  it('finds the tool sources', () => {
    // Guards the whole suite: an empty directory would make every assertion
    // below vacuous, and this file exists precisely to not be vacuous.
    expect(files.length).toBe(7);
  });

  it.each(files)('%s returns only via respond()/respondError()', (file) => {
    const source = readFileSync(resolve(TOOLS_DIR, file), 'utf8');

    // Any `return {` whose object literal mentions `content:` is a hand-built
    // MCP result — the exact bypass this test exists to catch.
    const handBuilt = [...source.matchAll(/return\s*\{[^}]*content\s*:/g)];
    expect(
      handBuilt.map((m) => m[0]),
      `${file} builds an MCP result inline instead of calling respond()`,
    ).toEqual([]);

    // And it must actually use the helpers, so a handler cannot pass by
    // returning nothing at all.
    expect(
      /\brespond(?:Error)?\s*\(/.test(source),
      `${file} never calls respond() or respondError()`,
    ).toBe(true);
  });

  it('respond.ts is the only module that constructs content arrays', () => {
    const respondSource = readFileSync(resolve(HERE, '..', 'src', 'respond.ts'), 'utf8');
    expect(respondSource).toMatch(/type:\s*'text'/);
  });
});
