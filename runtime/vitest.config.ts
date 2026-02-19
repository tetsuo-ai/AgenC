import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Explicitly resolve @coral-xyz/anchor to node_modules
      '@coral-xyz/anchor': resolve(__dirname, '../node_modules/@coral-xyz/anchor'),
      // Ensure tests always use the freshly built workspace SDK instead of stale file: copies.
      '@agenc/sdk': resolve(__dirname, '../sdk/dist/index.mjs'),
    },
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
