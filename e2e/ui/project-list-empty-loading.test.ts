import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';
import { applyStandardMocks } from '../lib/playwright/mock-factory.js';

test('[P1] empty project list, blank project return, and denied-list recovery @merge-extra', async ({ page, request, toolsDev }, testInfo) => {
  await applyStandardMocks(page);
  const listPath = '/api/projects';
  const emptyText = 'Create a project here first. It stays on this device.';
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400 && /\/api\/(projects|runs)(\?|$)/.test(response.url())) failures.push(response.url());
  });

  // The worker's daemon is shared with other files, so hold the list empty here.
  let empty = true;
  await page.route(`**${listPath}`, async (route) => {
    if (!empty || route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { projects: [] } });
  });

  await page.goto('/drafts');
  await expect(page.getByText(emptyText)).toBeVisible({ timeout: T.long });
  await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('empty-list.png') });

  empty = false;
  const projectId = `empty-loading-${Date.now()}`;
  const create = await request.post(toolsDev.url.daemon('/api/projects'), {
    data: { id: projectId, name: 'Blank project loading regression', skillId: null, designSystemId: null },
  });
  expect(create.ok()).toBeTruthy();
  try {
    const list = await request.get(toolsDev.url.daemon(listPath));
    expect(list.status()).toBe(200);
    expect((await list.json()).projects.some((row: { id: string }) => row.id === projectId)).toBe(true);
    await page.reload();
    await expect(page.getByTestId('recent-projects-strip').getByText('Blank project loading regression')).toBeVisible({ timeout: T.long });
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });
    await page.goBack();
    await expect(page.getByTestId('recent-projects-strip').getByText('Blank project loading regression')).toBeVisible({ timeout: T.long });
    expect(failures).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('blank-project-return.png') });
  } finally {
    const removed = await request.delete(toolsDev.url.daemon(`/api/projects/${projectId}`));
    expect(removed.ok()).toBeTruthy();
  }

  let denied = true;
  await page.route(`**${listPath}`, async (route) => {
    if (!denied || route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', retryable: true } } });
  });
  await page.reload();
  const error = page.getByRole('alert').filter({ hasText: 'Could not load projects' });
  await expect(error).toBeVisible({ timeout: T.long });
  await page.screenshot({ path: testInfo.outputPath('list-failure.png') });
  denied = false;
  empty = true;
  await error.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText(emptyText)).toBeVisible({ timeout: T.long });
  await expect(error).toHaveCount(0);
});
