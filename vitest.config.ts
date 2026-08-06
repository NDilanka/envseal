import { defineConfig } from 'vitest/config';

// Root-level suite: cross-cutting invariants that no single package can check
// because they are assertions *about* the package graph.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
