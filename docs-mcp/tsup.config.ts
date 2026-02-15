import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'node18',
  external: ['fs', 'path', 'os', 'crypto', 'url', 'events', 'util', 'node:*'],
});
