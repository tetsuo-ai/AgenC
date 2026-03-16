import { defineConfig } from 'tsup';

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
  external: ['fs', 'path', 'os', 'crypto', 'url', 'events', 'util', 'node:*'],
});
