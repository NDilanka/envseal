import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@envseal/detector': resolve(__dirname, '../../packages/detector/src/index.ts'),
      '@envseal/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@envseal/registry': resolve(__dirname, '../../packages/registry/src/index.ts'),
    },
  },
});
