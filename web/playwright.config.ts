import { defineConfig } from '@playwright/test';

const port = 5173;
const wsPort = Number(process.env.WEBCHAT_WS_PORT ?? 3600);
const webPort = Number(process.env.WEBCHAT_WEB_PORT ?? port);
const wsUrl = `ws://127.0.0.1:${wsPort}`;
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
      command: `WEBCHAT_WS_PORT=${wsPort} node test-server.mjs`,
      port: wsPort,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: `VITE_WEBCHAT_WS_URL=${wsUrl} npm run dev -- --host 127.0.0.1 --port ${webPort}`,
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
