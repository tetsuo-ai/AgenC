import { defineConfig } from 'tsup';

const entry = [
  'src/index.ts',
  'src/browser.ts',
  'src/operator-events.ts',
  'src/bin/agenc.ts',
  'src/bin/agenc-runtime.ts',
  'src/bin/agenc-watch.ts',
  'src/bin/daemon.ts',
];

const external = [
  '@tetsuo-ai/desktop-tool-contracts',
  '@tetsuo-ai/plugin-kit',
  'openai',
  'ollama',
  'better-sqlite3',
  'ioredis',
  'ws',
  'grammy',
  'discord.js',
  '@slack/bolt',
  '@whiskeysockets/baileys',
  'matrix-js-sdk',
  'cheerio',
  'playwright',
  'edge-tts',
  '@modelcontextprotocol/sdk',
];

export default defineConfig({
  entry,
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  external,
});
