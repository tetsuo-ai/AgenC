import { defineConfig } from 'tsup';
import path from 'path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'node18',
  // Bundle these dependencies into the output to avoid ESM/CJS interop
  // issues at runtime. @coral-xyz/anchor is CJS-only and causes failures
  // when consumed as an external dependency in both CJS and ESM contexts.
  noExternal: [
    '@coral-xyz/anchor',
    '@solana/web3.js',
    '@agenc/runtime',
    '@agenc/sdk',
  ],
  esbuildOptions(options) {
    // Force CJS resolution throughout the dependency tree.
    // esbuild's export map resolution picks .mjs files from @agenc/sdk
    // and @agenc/runtime, which triggers broken ESM interop with
    // @coral-xyz/anchor. Alias to CJS entry points directly.
    options.alias = {
      '@agenc/sdk': path.resolve(__dirname, '../sdk/dist/index.js'),
      '@agenc/runtime': path.resolve(__dirname, '../runtime/dist/index.js'),
    };
  },
});
