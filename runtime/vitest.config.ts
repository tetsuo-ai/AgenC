import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Explicitly resolve @coral-xyz/anchor to node_modules
      '@coral-xyz/anchor': resolve(__dirname, '..', 'node_modules/@coral-xyz/anchor'),
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
