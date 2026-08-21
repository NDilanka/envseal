import { build } from 'esbuild';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build script for the Claude Code plugin.
 *
 * 1. Generates an inlined registry stub (`@envseal/registry` → static data), so
 *    the bundled hooks never read provider JSON off disk at runtime and never
 *    reach the `import.meta.url` filesystem lookup in the real package.
 * 2. Bundles each hook and the statusline to standalone CommonJS in dist/.
 * 3. Bundles the MCP server into the plugin tree.
 *
 * The build writes ONLY into dist/ directories and scripts/generated/. It must
 * never touch .claude-plugin/plugin.json, hooks/hooks.json or .mcp.json: those
 * are tracked, hand-written, and portable. An earlier version rewrote
 * plugin.json's args to absolute paths on every build, which both dirtied the
 * working tree and committed one machine's layout into git — the plugin then
 * pointed at a directory that exists on nobody else's disk.
 *
 * Every path Claude Code executes is expressed as `${CLAUDE_PLUGIN_ROOT}/...`
 * in the tracked config files. Marketplace installs COPY the plugin into
 * ~/.claude/plugins/cache, so a path that escapes the plugin root (as
 * ../../packages/mcp-server/dist/bin.js did) cannot resolve after install.
 * That is why the MCP server is bundled in rather than referenced in place.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
const GENERATED_DIR = join(HERE, 'generated');

interface GeneratedVerify {
  method?: string;
  url?: string;
  headerTemplate?: Record<string, string>;
  expectStatus?: number[];
}
interface GeneratedKey {
  envVar: string;
  format: { prefix?: string; pattern?: string; example: string };
  rotateUrl?: string;
  verify?: GeneratedVerify;
}
interface GeneratedProvider {
  id: string;
  name: string;
  keys: GeneratedKey[];
}

function generateRegistryStub(): string {
  const providersDir = join(REPO_ROOT, 'packages', 'registry', 'providers');
  const files = readdirSync(providersDir).filter((f) => f.endsWith('.json')).sort();
  const providers: GeneratedProvider[] = [];
  for (const file of files) {
    const content = JSON.parse(readFileSync(join(providersDir, file), 'utf8')) as {
      id?: unknown;
      name?: unknown;
      keys?: unknown;
    };
    if (typeof content.id !== 'string' || typeof content.name !== 'string' || !Array.isArray(content.keys)) {
      throw new Error(`Malformed provider file ${file}`);
    }
    providers.push({
      id: content.id,
      name: content.name,
      keys: (content.keys as GeneratedKey[]).map((key) => ({
        envVar: key.envVar,
        format: {
          prefix: key.format?.prefix,
          pattern: key.format?.pattern,
          example: key.format?.example ?? '',
        },
        rotateUrl: key.rotateUrl,
        verify: key.verify,
      })),
    });
  }
  const json = JSON.stringify(providers, null, 2);
  return `// Generated at build time from packages/registry/providers/*.json — do not edit.
type StubVerify = {
  method?: string;
  url?: string;
  headerTemplate?: Record<string, string>;
  expectStatus?: number[];
};
type StubFormat = { prefix?: string; pattern?: string; example: string };
type StubKey = {
  envVar: string;
  format: StubFormat;
  rotateUrl?: string;
  verify?: StubVerify;
};
type StubProvider = { id: string; name: string; keys: StubKey[] };

const PROVIDERS = ${json} as StubProvider[];

export function allProviders(): StubProvider[] { return PROVIDERS; }

export function getProvider(id: string): StubProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function findKey(
  envVar: string,
): { provider: StubProvider; key: StubKey } | undefined {
  for (const provider of PROVIDERS) {
    const key = provider.keys.find((k) => k.envVar === envVar);
    if (key !== undefined) return { provider, key };
  }
  return undefined;
}

// Must stay byte-for-byte equivalent to @envseal/registry's allProbeHosts:
// core/approvals.ts tests membership with \`allowlist.has(url.hostname)\`, so a
// stub that yielded provider IDs (as this once did) makes every probe host
// look unapproved.
export function allProbeHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const provider of PROVIDERS) {
    for (const key of provider.keys) {
      if (key.verify?.url === undefined) continue;
      try {
        hosts.add(new URL(key.verify.url).hostname);
      } catch {
        // Invalid URL, skip — same as the real registry.
      }
    }
  }
  return hosts;
}

export function allPrefixPatterns(): Array<{
  providerId: string;
  envVar: string;
  prefix?: string;
  pattern?: string;
}> {
  const out: Array<{ providerId: string; envVar: string; prefix?: string; pattern?: string }> = [];
  for (const provider of PROVIDERS) {
    for (const key of provider.keys) {
      out.push({
        providerId: provider.id,
        envVar: key.envVar,
        prefix: key.format.prefix,
        pattern: key.format.pattern,
      });
    }
  }
  return out;
}
`;
}

async function bundleHooks(registryStub: string): Promise<void> {
  const targets: Array<{ entry: string; outfile: string }> = [
    {
      entry: join(PLUGIN_ROOT, 'hooks', 'pre-tool-use.ts'),
      outfile: join(PLUGIN_ROOT, 'hooks', 'dist', 'pre-tool-use.cjs'),
    },
    {
      entry: join(PLUGIN_ROOT, 'hooks', 'user-prompt-submit.ts'),
      outfile: join(PLUGIN_ROOT, 'hooks', 'dist', 'user-prompt-submit.cjs'),
    },
    {
      entry: join(PLUGIN_ROOT, 'hooks', 'session-start.ts'),
      outfile: join(PLUGIN_ROOT, 'hooks', 'dist', 'session-start.cjs'),
    },
  ];
  for (const target of targets) {
    await build({
      entryPoints: [target.entry],
      outfile: target.outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      // jsonc-parser's "main" is a UMD bundle whose internal require('./impl/*')
      // calls do not survive bundling — the hook then dies at startup with
      // MODULE_NOT_FOUND. Preferring the ESM entry gives esbuild real imports
      // it can inline.
      mainFields: ['module', 'main'],
      conditions: ['import', 'node', 'default'],
      minify: true,
      legalComments: 'none',
      alias: { '@envseal/registry': registryStub },
      logLevel: 'info',
    });
  }
}

async function bundleStatusline(registryStub: string): Promise<void> {
  await build({
    entryPoints: [join(PLUGIN_ROOT, 'statusline', 'statusline.ts')],
    outfile: join(PLUGIN_ROOT, 'statusline', 'dist', 'statusline.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    mainFields: ['module', 'main'],
    conditions: ['import', 'node', 'default'],
    minify: true,
    legalComments: 'none',
    alias: { '@envseal/registry': registryStub },
    logLevel: 'info',
  });
}

/**
 * Bundle the MCP server into the plugin so `${CLAUDE_PLUGIN_ROOT}` can reach it.
 *
 * Entry is the package's BUILT dist/bin.js, not its TypeScript source: dist is
 * the artifact `envseal-mcp` itself runs, so bundling it keeps the plugin's
 * broker byte-identical in behaviour to the standalone binary, and the plugin
 * build does not fail when the server's source is mid-edit.
 */
async function bundleMcpServer(registryStub: string): Promise<void> {
  const entry = join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'bin.js');
  if (!existsSync(entry)) {
    throw new Error(
      `Missing ${entry}. Run \`pnpm -r build\` first: the plugin bundles the ` +
        'MCP server so ${CLAUDE_PLUGIN_ROOT} can reach it after a marketplace install.',
    );
  }
  await build({
    entryPoints: [entry],
    outfile: join(PLUGIN_ROOT, 'mcp', 'dist', 'envseal-mcp.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    mainFields: ['module', 'main'],
    conditions: ['import', 'node', 'default'],
    minify: true,
    legalComments: 'none',
    // @envseal/registry resolves its provider JSON relative to import.meta.url;
    // once bundled that points at mcp/dist, where no providers/ exists. Same
    // static stub the hooks use, so the plugin's broker and the standalone
    // envseal-mcp binary see identical provider data.
    alias: { '@envseal/registry': registryStub },
    logLevel: 'info',
  });
}

async function main(): Promise<void> {
  mkdirSync(GENERATED_DIR, { recursive: true });
  const registryStub = join(GENERATED_DIR, 'registry-stub.generated.ts');
  writeFileSync(registryStub, generateRegistryStub(), 'utf8');

  for (const outDir of [
    join(PLUGIN_ROOT, 'hooks', 'dist'),
    join(PLUGIN_ROOT, 'statusline', 'dist'),
    join(PLUGIN_ROOT, 'mcp', 'dist'),
  ]) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
  }

  await bundleHooks(registryStub);
  await bundleStatusline(registryStub);
  await bundleMcpServer(registryStub);

  for (const f of [
    'hooks/dist/pre-tool-use.cjs',
    'hooks/dist/user-prompt-submit.cjs',
    'hooks/dist/session-start.cjs',
    'statusline/dist/statusline.cjs',
    'mcp/dist/envseal-mcp.cjs',
  ]) {
    const p = join(PLUGIN_ROOT, f);
    if (!existsSync(p)) throw new Error(`Build did not produce ${p}`);
  }
  console.log('envseal plugin build complete.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
