import { defineConfig } from 'tsup';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'node18',
  // Keep the emitted JS filename stable so package metadata can point at an
  // intentional CommonJS entrypoint instead of relying on tsup defaults.
  outExtension() {
    return { js: '.cjs' };
  },
  // Bundle everything - resolving anchor interop at build time
  noExternal: [/.*/],
  esbuildOptions(options) {
    // Force resolution to CJS entry points.
    // The SDK/Runtime .mjs files have broken anchor interop,
    // so we resolve to .js (CJS) entries where require() works.
    options.alias = {
      '@tetsuo-ai/sdk': require.resolve('@tetsuo-ai/sdk'),
      '@tetsuo-ai/runtime': require.resolve('@tetsuo-ai/runtime'),
    };
    // Mark native Node modules as external
    options.external = [
      'fs',
      'path',
      'os',
      'crypto',
      'http',
      'https',
      'net',
      'tls',
      'stream',
      'url',
      'zlib',
      'events',
      'util',
      'buffer',
      'assert',
      'child_process',
      'worker_threads',
      'node:*',
      // Keep browser automation internals external to avoid bundling optional
      // playwright-core/chromium-bidi dependency trees into MCP.
      'playwright',
      'playwright-core',
      'chromium-bidi',
      'chromium-bidi/*',
    ];
  },
});
