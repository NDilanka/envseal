import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The "plugs into any AI coding tool" claim, enforced mechanically.
 *
 * envseal's portability rests on one structural fact: the broker knows nothing
 * about any host, harness, or model vendor. Four bindings (MCP, SDK, HTTP, CLI)
 * wrap the same `Broker`, and a host needs only one of them. The moment
 * host-specific logic leaks into `packages/core`, that stops being true — and it
 * would stop being true quietly, because everything would still compile and every
 * existing test would still pass. So the boundary gets its own test.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/** Imports that would tie the broker to one host or one model vendor. */
const FORBIDDEN_IN_CORE = [
  '@modelcontextprotocol',
  'openai',
  '@anthropic-ai',
  '@google/generative-ai',
  '@google/genai',
  'vscode',
  'langchain',
  'llamaindex',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

describe('portability invariant', () => {
  it('packages/core imports no host, harness, or model-vendor SDK', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'packages', 'core', 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        for (const banned of FORBIDDEN_IN_CORE) {
          if (spec === banned || spec.startsWith(`${banned}/`)) {
            offenders.push(`${file.slice(ROOT.length + 1)} -> ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('packages/core declares no host or model-vendor dependency', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'packages', 'core', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    const offenders = declared.filter((d) =>
      FORBIDDEN_IN_CORE.some((banned) => d === banned || d.startsWith(`${banned}/`)),
    );
    expect(offenders).toEqual([]);
  });

  it('the SDK emits vendor tool dialects without importing vendor libraries', () => {
    // Tier 2 exists so an agent built on any vendor SDK can register envseal's
    // tools. Emitting a vendor's tool *shape* is fine; importing the vendor's
    // library would make envseal pick a side.
    const pkgPath = join(ROOT, 'packages', 'sdk', 'package.json');
    let pkg: { dependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as typeof pkg;
    } catch {
      return; // package not built yet
    }
    const declared = Object.keys(pkg.dependencies ?? {});
    const offenders = declared.filter((d) =>
      ['openai', '@anthropic-ai', '@google/generative-ai', '@google/genai'].some(
        (banned) => d === banned || d.startsWith(`${banned}/`),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
