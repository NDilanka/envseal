#!/usr/bin/env node
// prepublishOnly guard for every publishable @envseal/* package.
//
// The packages depend on each other through pnpm's `workspace:*` protocol. `pnpm publish`
// rewrites that to the concrete version before uploading; `npm publish` does not, and ships
// `"@envseal/core": "workspace:*"` verbatim. Every install of such a tarball dies with
// EUNSUPPORTEDPROTOCOL, and the only fix is an unpublish/version bump. So: refuse to publish
// unless pnpm is driving.
//
// `pnpm publish` strips publish lifecycle scripts from the published manifest (manifest
// obfuscation), so this hook does not reach consumers.

const ua = process.env.npm_config_user_agent ?? '';
const isPnpm = ua.startsWith('pnpm/');
const isDryRun = process.env.npm_config_dry_run === 'true';
const override = process.env.ENVSEAL_ALLOW_NPM_PUBLISH === '1';

if (isPnpm || isDryRun || override) {
  process.exit(0);
}

const pkg = process.env.npm_package_name ?? 'this package';
process.stderr.write(
  `\n  refusing to publish ${pkg} with a non-pnpm client (user agent: ${ua || 'unknown'}).\n\n` +
    `  npm and yarn do not rewrite pnpm's \`workspace:\` protocol, so the tarball would ship\n` +
    `  \`"@envseal/core": "workspace:*"\` and every install would fail with EUNSUPPORTEDPROTOCOL.\n\n` +
    `  Use the release script instead:  pnpm release\n` +
    `  See docs/publishing.md.\n\n`,
);
process.exit(1);
