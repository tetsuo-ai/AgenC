import { defineConfig } from 'tsup';
import path from 'path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'node18',
  // Bundle everything - resolving anchor interop at build time
  noExternal: [/.*/],
  esbuildOptions(options) {
    // Force resolution to CJS entry points.
    // The SDK/Runtime .mjs files have broken anchor interop,
    // so we resolve to .js (CJS) entries where require() works.
    options.alias = {
      '@agenc/sdk': path.resolve(__dirname, '../sdk/dist/index.js'),
      '@agenc/runtime': path.resolve(__dirname, '../runtime/dist/index.js'),
    };
    // Mark native Node modules as external
    options.external = ['fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'stream', 'url', 'zlib', 'events', 'util', 'buffer', 'assert', 'child_process', 'worker_threads', 'node:*'];
  },
});
