import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noSecretToLog from './tools/eslint-rules/no-secret-to-log.js';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/hooks/dist/**',
      '**/statusline/dist/**',
      '**/generated/**',
      'spec/**',
      // Bundled CJS output and the build-time registry stub are generated
      // artifacts; linting them reports on esbuild's choices, not ours.
      'plugins/*/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Verification probe scripts and build helpers: plain Node ESM, not part of
    // any package's tsconfig, so they need their globals declared explicitly.
    files: ['**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        performance: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      // Probes are throwaway diagnostics; an unused binding while narrowing a
      // failure is not worth failing the gate over.
      '@typescript-eslint/no-unused-vars': 'warn',
      'no-irregular-whitespace': 'warn',
    },
  },
  {
    files: ['**/*.ts'],
    plugins: { envseal: { rules: { 'no-secret-to-log': noSecretToLog } } },
    rules: {
      // A cast that silences a type error also silences the design feedback the
      // type was carrying. Three separate runtime failures in this codebase --
      // an MCP server that could not start, an SDK that resolved six of seven
      // tools to "not available", and a test-mode prompter that was never
      // selected -- were each an `as never` / `as any` hiding an API mismatch.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Unused imports are cruft, not defects. Kept visible as warnings so the
      // lint gate fails on things that can actually break, not on tidiness.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/prefer-as-const': 'warn',
      'prefer-const': 'warn',
      'envseal/no-secret-to-log': 'error',
      'no-console': 'off',
    },
  },
  {
    // Tests legitimately construct sentinels and poke at internals.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'envseal/no-secret-to-log': 'off',
      // Tests use require() to re-read a module after mutating the filesystem,
      // which ESM's import cache makes awkward.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
