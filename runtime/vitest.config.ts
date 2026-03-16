import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // npm workspaces hoist deps to the monorepo root and symlink workspace
    // packages into node_modules/@tetsuo-ai/*. No manual aliases needed.
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    deps: {
      interopDefault: true,
    },
  },
});
