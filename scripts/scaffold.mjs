// One-shot scaffolder for the envseal workspace package skeletons.
// Idempotent: it will not overwrite an existing package.json or tsconfig.json.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Array<{name:string, deps?:string[], bin?:Record<string,string>}>} */
const pkgs = [
  { name: 'protocol' },
  { name: 'detector', deps: ['registry'] },
  { name: 'registry' },
  { name: 'core', deps: ['protocol', 'registry', 'detector'] },
  { name: 'prompters', deps: ['protocol', 'core'] },
  { name: 'mcp-server', deps: ['protocol', 'core', 'prompters', 'registry'] },
  { name: 'sdk', deps: ['protocol', 'core', 'prompters', 'registry'] },
  { name: 'http-server', deps: ['protocol', 'core', 'prompters'] },
  { name: 'cli', deps: ['protocol', 'core', 'prompters', 'registry', 'detector', 'mcp-server', 'http-server'] },
];

for (const p of pkgs) {
  const dir = join(root, 'packages', p.name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });

  const pkgJsonPath = join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    const dependencies = {};
    for (const d of p.deps ?? []) dependencies[`@envseal/${d}`] = 'workspace:*';
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: `@envseal/${p.name}`,
          version: '0.1.0',
          type: 'module',
          license: 'Apache-2.0',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
          files: ['dist'],
          scripts: {
            build: 'tsc -p tsconfig.json',
            typecheck: 'tsc -p tsconfig.json --noEmit',
            test: 'vitest run',
          },
          ...(Object.keys(dependencies).length ? { dependencies } : {}),
        },
        null,
        2,
      ) + '\n',
    );
  }

  const tsconfigPath = join(dir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          extends: '../../tsconfig.base.json',
          compilerOptions: { rootDir: 'src', outDir: 'dist' },
          include: ['src/**/*'],
        },
        null,
        2,
      ) + '\n',
    );
  }

  const vitestPath = join(dir, 'vitest.config.ts');
  if (!existsSync(vitestPath)) {
    writeFileSync(
      vitestPath,
      `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: { include: ['test/**/*.test.ts'], environment: 'node' },\n});\n`,
    );
  }
}

console.log(`scaffolded ${pkgs.length} packages`);
