import { expect, test, type Page } from '@playwright/test';

const WS_URL = process.env.WEBCHAT_WS_URL ?? 'ws://127.0.0.1:3600';

function appUrl(path = '/') {
  return `${path}?ws=${encodeURIComponent(WS_URL)}`;
}

const VIEWS: Array<{ nav: string; heading: string }> = [
  { nav: 'Status', heading: 'Agent Status' },
  { nav: 'Runs', heading: 'Run Dashboard' },
  { nav: 'Skills', heading: 'Skills' },
  { nav: 'Tasks', heading: 'Tasks' },
  { nav: 'Memory', heading: 'Memory' },
  { nav: 'Activity', heading: 'Activity Feed' },
  { nav: 'Desktop', heading: 'Desktop Sandboxes' },
];

async function sendChatMessage(page: Page, text: string) {
  const sendButton = page.getByRole('button', { name: /\[send\]/i });
  const input = page.getByPlaceholder('Enter command...');
  await expect(input).toBeEditable();
  await input.fill(text);
  await expect(sendButton).toBeEnabled({ timeout: 12_000 });
  await sendButton.click();
}

test.describe('Web chat and tool execution', () => {
  test('connects, sends a message, and receives a response', async ({ page }) => {
    await page.goto(appUrl());

    await expect(page.getByPlaceholder('Enter command...')).toBeVisible();
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
    await expect(page.getByPlaceholder('Enter command...')).toBeVisible();
  });

  test('supports the full run dashboard operator surface without polluting chat', async ({ page }) => {
    await page.goto(appUrl());

    await sendChatMessage(page, 'seed run dashboard');
    await expect(page.getByText('You said: "seed run dashboard"', { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    await page.locator('button[title="Runs"]').click();
    await expect(page.getByRole('heading', { name: 'Run Dashboard', exact: true })).toBeVisible();
    await expect(page.locator('section').getByText('Watch the demo process until it exits cleanly.')).toBeVisible();

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('section').getByText('Run is paused by an operator and will not make progress until resumed.')).toBeVisible();
    await expect(page.locator('section').getByText('run_paused')).toBeVisible();

    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('section').getByText('Run is active and waiting for the next verification cycle.', { exact: false })).toBeVisible();
    await expect(page.locator('section').getByText('run_resumed')).toBeVisible();

    await page.getByLabel('Run objective').fill('Track the demo process and report the exit code.');
    await page.getByRole('button', { name: 'Save Objective' }).click();
    await expect(page.locator('section').getByText('Track the demo process and report the exit code.')).toBeVisible();
    await expect(page.locator('section').getByText('run_objective_updated')).toBeVisible();

    await page.getByLabel('Success criteria').fill('Keep the process visible.\nReport the final exit code.');
    await page.getByLabel('Completion criteria').fill('Observe terminal evidence.');
    await page.getByLabel('Blocked criteria').fill('Pause if approval is required.');
    await page.getByLabel('Next check interval').fill('9000');
    await page.getByLabel('Heartbeat interval').fill('15000');
    await page.getByLabel('Requires user stop').check();
    await page.getByRole('button', { name: 'Apply Constraints' }).click();
    await expect(page.locator('section').getByText('run_contract_amended')).toBeVisible();
    await expect(page.getByText('"requiresUserStop": true')).toBeVisible();
    await expect(page.getByText('"nextCheckMs": 9000')).toBeVisible();

    await page.getByLabel('Maximum runtime').fill('120000');
    await page.getByLabel('Maximum cycles').fill('12');
    await page.getByLabel('Maximum idle time').fill('30000');
    await page.getByRole('button', { name: 'Apply Budget' }).click();
    await expect(page.locator('section').getByText('run_budget_adjusted')).toBeVisible();
    await expect(page.getByLabel('Maximum runtime')).toHaveValue('120000');

    await page.getByLabel('Preferred worker id').fill('worker-canary-2');
    await page.getByLabel('Worker affinity key').fill('tenant-demo/project-demo');
    await page.getByRole('button', { name: 'Reassign Worker' }).click();
    await expect(page.locator('section').getByText('run_worker_reassigned')).toBeVisible();
    await expect(page.getByLabel('Preferred worker id')).toHaveValue('worker-canary-2');

    await page.getByRole('button', { name: 'Force Compact' }).click();
    await expect(page.locator('section').getByText('run_compaction_forced')).toBeVisible();
    await expect(page.locator('section').getByText('Carry-forward state was refreshed by an operator override.')).toBeVisible();

    await page.getByLabel('Verification override reason').fill('Continue after reviewing the latest evidence.');
    await page.getByRole('button', { name: 'Override Continue' }).click();
    await expect(page.locator('section').getByText('run_verification_overridden')).toBeVisible();
    await expect(page.locator('section').getByText('Continue after reviewing the latest evidence.')).toBeVisible();

    await page.getByLabel('Verification override reason').fill('Accept the current completion result.');
    await page.getByRole('button', { name: 'Override Complete' }).click();
    await expect(page.locator('section').getByText('Run completed and the runtime recorded a terminal result.')).toBeVisible();

    await page.getByRole('button', { name: 'Retry Checkpoint' }).click();
    await expect(page.locator('section').getByText('Run resumed from the latest checkpoint and is active again.')).toBeVisible();
    await expect(page.locator('section').getByText('run_retried')).toBeVisible();

    await page.getByLabel('Verification override reason').fill('Mark this run failed for operator review.');
    await page.getByRole('button', { name: 'Override Fail' }).click();
    await expect(page.locator('section').getByText('Run failed and needs operator review before it is retried.')).toBeVisible();

    await page.getByRole('button', { name: 'Retry Checkpoint' }).click();
    await expect(page.locator('section').getByText('Run resumed from the latest checkpoint and is active again.')).toBeVisible();

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('section').getByText('Run was cancelled and is no longer executing.')).toBeVisible();
    await expect(page.locator('section').getByText('run_cancelled')).toBeVisible();

    await page.locator('button[title="Chat"]').click();
    await expect(page.getByPlaceholder('Enter command...')).toBeVisible();
    await expect(page.getByText('Run Dashboard', { exact: true })).toHaveCount(0);
    await expect(page.getByText('You said: "seed run dashboard"', { exact: false })).toBeVisible();
  });

  test('loads settings from the main navigation', async ({ page }) => {
    await page.goto(appUrl());

    await page.locator('button[title="Settings"]').click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByText('LLM Provider')).toBeVisible();
    await expect(page.getByText('Tool Approvals')).toBeVisible();
  });
});

test('displays pending approval from gateway', async ({ page }) => {
  await page.goto(appUrl());
  await expect(page.getByText('APPROVAL REQUIRED', { exact: false })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole('button', { name: /\[review\]/i })).toBeVisible();
});
