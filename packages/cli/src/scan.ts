import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { findKey } from '@envseal/registry';

/**
 * Discover environment variables a project actually reads.
 *
 * Deliberately syntactic rather than semantic: a regex sweep over source text
 * finds the overwhelming majority of real references at a fraction of the cost
 * of parsing every dialect a polyglot repo might contain, and a missed variable
 * is a prompt the user answers once, not a failure.
 */

const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.php', '.cs',
  '.sh', '.bash', '.zsh', '.yml', '.yaml', '.toml',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.svelte-kit', 'coverage', '.venv', 'venv',
  '__pycache__', '.envseal', '.turbo', '.cache',
]);

/**
 * Names that are configuration rather than credentials. Declaring these as
 * secrets would pop a password prompt for `NODE_ENV`, which teaches users to
 * dismiss the prompt without reading it — the exact habit this tool exists to
 * break.
 */
const NON_SECRET = new Set([
  'NODE_ENV', 'PORT', 'HOST', 'CI', 'HOME', 'PATH', 'PWD', 'USER', 'SHELL',
  'LANG', 'TZ', 'TERM', 'TMPDIR', 'LOG_LEVEL', 'DEBUG', 'VERBOSE',
  'npm_lifecycle_event', 'npm_package_version',
]);

/** Prefixes that a bundler inlines into client bundles — public by construction. */
const PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'VITE_', 'REACT_APP_', 'PUBLIC_', 'EXPO_PUBLIC_', 'NUXT_PUBLIC_'];

const PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[['"`]([A-Z][A-Z0-9_]*)['"`]\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /os\.environ(?:\.get)?[[(]['"]([A-Z][A-Z0-9_]*)['"]/g,
  /Deno\.env\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
  /ENV\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  /os\.Getenv\(['"`]([A-Z][A-Z0-9_]*)['"`]\)/g,
  /std::env::var\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
  /getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
  /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g,
];

export interface DiscoveredKey {
  key: string;
  secret: boolean;
  files: string[];
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 12) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out, depth + 1);
    } else if (SOURCE_EXT.has(extname(entry)) && st.size < 2_000_000) {
      out.push(full);
    }
  }
}

export function scanForEnvKeys(root: string): DiscoveredKey[] {
  const files: string[] = [];
  walk(root, files);

  const found = new Map<string, Set<string>>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const source of PATTERNS) {
      const re = new RegExp(source.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (name === undefined || name.length < 3) continue;
        const rel = file.slice(root.length + 1).replace(/\\/g, '/');
        const set = found.get(name) ?? new Set<string>();
        set.add(rel);
        found.set(name, set);
      }
    }
  }

  return [...found.entries()]
    .map(([key, fileSet]) => ({
      key,
      secret: !NON_SECRET.has(key) && !PUBLIC_PREFIXES.some((p) => key.startsWith(p)),
      files: [...fileSet].sort().slice(0, 5),
    }))
    .filter((d) => !NON_SECRET.has(d.key) || d.secret)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Build a manifest entry, filling provider metadata from the registry when the name is known. */
export function entryForKey(d: DiscoveredKey): Record<string, unknown> {
  const where = d.files.length > 0 ? ` Referenced in ${d.files.join(', ')}.` : '';
  const known = findKey(d.key);

  const entry: Record<string, unknown> = {
    key: d.key,
    description: known ? `${known.key.description}${where}` : `Environment variable ${d.key}.${where}`,
    required: true,
    secret: d.secret,
    sink: 'dotenv',
  };

  if (known) {
    if (known.key.format) entry.format = known.key.format;
    const p: Record<string, unknown> = { id: known.provider.id, name: known.provider.name };
    if (known.key.signupUrl) p.signupUrl = known.key.signupUrl;
    if (known.key.docsUrl) p.docsUrl = known.key.docsUrl;
    if (known.key.rotateUrl) p.rotateUrl = known.key.rotateUrl;
    entry.provider = p;
    if (known.key.verify) entry.verify = known.key.verify;
  }

  return entry;
}
