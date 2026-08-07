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
 * 3. Rewrites .claude-plugin/plugin.json command args from relative to absolute
 *    paths so Claude Code can run them regardless of its working directory.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
const GENERATED_DIR = join(HERE, 'generated');

interface GeneratedKey {
  envVar: string;
  format: { prefix?: string; pattern?: string; example: string };
  rotateUrl?: string;
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
      })),
    });
  }
  const json = JSON.stringify(providers, null, 2);
  return `// Generated at build time from packages/registry/providers/*.json — do not edit.
type StubFormat = { prefix?: string; pattern?: string; example: string };
type StubKey = { envVar: string; format: StubFormat; rotateUrl?: string };
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

export function allProbeHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const provider of PROVIDERS) {
    for (const key of provider.keys) {
      if (key.format.pattern !== undefined) hosts.add(provider.id);
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

interface PluginJson {
  mcp_servers?: Array<{ id?: string; command?: string; args?: string[] }>;
  hooks?: Array<{ type?: string; command?: string; args?: string[] }>;
  statusline_item?: { command?: string; args?: string[] };
  [key: string]: unknown;
}

function resolvePluginJson(): void {
  const pluginDir = join(PLUGIN_ROOT, '.claude-plugin');
  const file = join(pluginDir, 'plugin.json');
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}`);
  }

  const abs = (rel: string): string => resolve(PLUGIN_ROOT, rel);

  const relOverrides: Record<string, string> = {
    'hooks/dist/pre-tool-use.cjs': abs('hooks/dist/pre-tool-use.cjs'),
    'hooks/dist/user-prompt-submit.cjs': abs('hooks/dist/user-prompt-submit.cjs'),
    'hooks/dist/session-start.cjs': abs('hooks/dist/session-start.cjs'),
    'statusline/dist/statusline.cjs': abs('statusline/dist/statusline.cjs'),
    'packages/mcp-server/dist/bin.js': abs('../../packages/mcp-server/dist/bin.js'),
  };

  const plugin = JSON.parse(readFileSync(file, 'utf8')) as PluginJson;

  const rewrite = (cmd: { args?: string[] } | undefined): void => {
    if (cmd?.args === undefined) return;
    cmd.args = cmd.args.map((arg) => {
      const overridden = Object.keys(relOverrides).find((rel) => arg === rel || arg.endsWith(`/${rel}`));
      return overridden !== undefined ? relOverrides[overridden]! : arg;
    });
  };

  for (const server of plugin.mcp_servers ?? []) rewrite(server);
  for (const hook of plugin.hooks ?? []) rewrite(hook);
  rewrite(plugin.statusline_item);

  writeFileSync(file, JSON.stringify(plugin, null, 2) + '\n', 'utf8');
}

async function main(): Promise<void> {
  mkdirSync(GENERATED_DIR, { recursive: true });
  const registryStub = join(GENERATED_DIR, 'registry-stub.generated.ts');
  writeFileSync(registryStub, generateRegistryStub(), 'utf8');

  for (const outDir of [
    join(PLUGIN_ROOT, 'hooks', 'dist'),
    join(PLUGIN_ROOT, 'statusline', 'dist'),
  ]) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
  }

  await bundleHooks(registryStub);
  await bundleStatusline(registryStub);
  resolvePluginJson();

  for (const f of [
    'hooks/dist/pre-tool-use.cjs',
    'hooks/dist/user-prompt-submit.cjs',
    'hooks/dist/session-start.cjs',
    'statusline/dist/statusline.cjs',
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
