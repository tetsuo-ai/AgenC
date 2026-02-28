import { expect, test, type Page } from '@playwright/test';

const WS_URL = process.env.WEBCHAT_WS_URL ?? 'ws://127.0.0.1:3600';

function appUrl(path = '/') {
  return `${path}?ws=${encodeURIComponent(WS_URL)}`;
}

const VIEWS: Array<{ nav: string; heading: string }> = [
  { nav: 'Status', heading: 'Agent Status' },
  { nav: 'Skills', heading: 'Skills' },
  { nav: 'Tasks', heading: 'Tasks' },
  { nav: 'Memory', heading: 'Memory' },
  { nav: 'Activity', heading: 'Activity Feed' },
  { nav: 'Desktop', heading: 'Desktop Sandboxes' },
];

async function sendChatMessage(page: Page, text: string) {
  const sendButton = page.getByRole('button', { name: 'Send' });
  const input = page.getByPlaceholder('Message to AgenC...');
  await expect(input).toBeEditable();
  await input.fill(text);
  await expect(sendButton).toBeEnabled({ timeout: 12_000 });
  await sendButton.click();
}

test.describe('Web chat and tool execution', () => {
  test('connects, sends a message, and receives a response', async ({ page }) => {
    await page.goto(appUrl());

    await expect(page.getByPlaceholder('Message to AgenC...')).toBeVisible();
    await sendChatMessage(page, 'hello from e2e');

    await expect(page.getByText('You said: "hello from e2e"', { exact: false })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('renders tool call progress and result for tool-tagged messages', async ({ page }) => {
    await page.goto(appUrl());

    await sendChatMessage(page, 'please run tool chain');
    await expect(page.getByRole('button', { name: /tool call/i })).toBeVisible({ timeout: 15_000 });

    const toolGroup = page.getByRole('button', { name: /tool call/i });
    await toolGroup.click();
    await expect(page.getByText('agenc.listTasks')).toBeVisible();
    const toolCallEntry = page.getByRole('button', { name: /agenc\.listTasks/i });
    await toolCallEntry.click();
    await expect(page.getByText('"task_1"')).toBeVisible();
  });
});

test.describe('site navigation paths', () => {
  test('loads each main web view', async ({ page }) => {
    await page.goto(appUrl());

    await sendChatMessage(page, 'seed for nav flow');
    await expect(page.getByText('You said: "seed for nav flow"', { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    for (const { nav, heading } of VIEWS) {
      await page.locator(`button[title="${nav}"]`).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 10_000 });
    }

    await page.locator('button[title="Chat"]').click();
    await expect(page.getByPlaceholder('Message to AgenC...')).toBeVisible();
  });

  test('opens right panel settings and payment tabs', async ({ page }) => {
    await page.goto(appUrl());

    await expect(page.getByText('Recent Chats')).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('LLM Provider')).toBeVisible();

    await page.getByRole('button', { name: 'Payment' }).click();
    await expect(page.getByText('SOL Balance')).toBeVisible();
    await expect(page.getByText('Protocol Fees')).toBeVisible();
  });
});

test('displays pending approval from gateway', async ({ page }) => {
  await page.goto(appUrl());
  await expect(page.getByText('Review', { exact: false })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText('pending approval', { exact: false })).toBeVisible();
});
