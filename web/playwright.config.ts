import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const port = 5173;
const wsPort = Number(process.env.WEBCHAT_WS_PORT ?? 3600);
const webPort = Number(process.env.WEBCHAT_WEB_PORT ?? port);
const wsUrl = `ws://127.0.0.1:${wsPort}`;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
process.env.WEBCHAT_WS_URL = wsUrl;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'on-first-retry',
  },
  expect: {
    timeout: 10_000,
  },
  webServer: [
    {
      command: `WEBCHAT_WS_PORT=${wsPort} node ./web/test-server.mjs`,
      cwd: repoRoot,
      port: wsPort,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // Use the repo-root Vite install because web/node_modules may be partial
      // during workspace runs, which breaks CSS transforms in Playwright dev mode.
      command: `VITE_WEBCHAT_WS_URL=${wsUrl} node ./node_modules/vite/bin/vite.js ./web --config ./web/vite.config.ts --host 127.0.0.1 --port ${webPort}`,
      cwd: repoRoot,
      port: webPort,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {},
    },
  ],
});
