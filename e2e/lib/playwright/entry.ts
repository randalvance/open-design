import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { dismissWhatsNewPopup, ensureRailOpen } from './rail.js';
import { T } from '@/timeouts';

export const STORAGE_KEY = 'open-design:config';
export const OPEN_SETTINGS_LABEL = /Open settings|打开设置|開啟設定|Account & settings/i;

export async function waitForLoadingToClear(page: Page) {
  await page.getByText('Loading OpenDesign…').waitFor({ state: 'hidden', timeout: T.long }).catch(() => {});
}

export async function dismissPrivacyDialog(page: Page) {
  const privacySurface = page
    .getByRole('region', { name: /Help us improve OpenDesign/i })
    .or(page.locator('.privacy-consent-banner'))
    .first();
  await privacySurface.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {});
  if (await privacySurface.isVisible().catch(() => false)) {
    await privacySurface
      .getByRole('button', { name: /don['’]?t share|不分享|not now|i get it|got it/i })
      .click();
    await expect(privacySurface).toBeHidden();
  }
}

export async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
}

export async function expectWorkspaceReady(page: Page) {
  await waitForLoadingToClear(page);
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  // The composer mounts before the project has finished loading, but remains
  // read-only until then. Wait on the actual submit gate so callers cannot
  // race into an opaque click timeout.
  await expect(page.getByTestId('chat-composer-input')).toBeEditable({ timeout: T.medium });
}

/**
 * #5517 moved the entry settings chip into the nav rail footer. The rail is
 * collapsed by default and carries `inert` while collapsed, so the chip is
 * present but neither focusable nor clickable — even a programmatic
 * `element.click()` is a no-op — and `getByRole` cannot see it at all because
 * the collapsed rail is `aria-hidden`. Expand the rail first whenever we are on
 * an entry view; inside a project workspace there is no rail to expand.
 */
async function ensureEntryRailOpenIfPresent(page: Page) {
  if ((await page.locator('.entry').count()) === 0) return;
  await ensureRailOpen(page).catch(() => {});
}

/**
 * The settings surface. Current entry and project launchers route to the
 * settings page, where `SettingsDialog` renders in `presentation="page"`
 * mode (`role="region"`, no `aria-modal`). Match the shared surface class so
 * this helper also remains correct if a modal presentation is used again.
 */
export function settingsSurface(page: Page) {
  // Match only `.modal-settings` — the class both presentations share, so the
  // bare `role="dialog"` fallback this used to carry was already redundant. It
  // was also actively wrong: AvatarMenu's popover is a `role="dialog"` too, so
  // the fallback could resolve to the agent menu and let a test assert
  // against the wrong surface.
  return page.locator('.modal-settings').first();
}

/**
 * Open Settings from a project/workspace surface.
 *
 * Every `entry-*` settings trigger lives on the entry (Home) shell, so none of
 * them exists once a project is open. #5517 also left `EntrySettingsMenu`
 * (`entry-settings-menu-trigger` / `entry-settings-open-details`) and
 * `AppChromeHeader`'s `SettingsIconButton` (`.settings-icon-btn`) unrendered,
 * so the project surface's only settings entry is the composer's model popover:
 * open `AvatarMenu`, then take its pinned `avatar-open-execution-settings` row.
 * The topbar `InlineModelSwitcher` carries the same row under
 * `inline-model-switcher-open-settings`, so try that as a second route.
 *
 * Returns true when it managed to click a trigger, false when this page has no
 * in-project settings entry to drive.
 */
async function openSettingsFromProjectSurface(page: Page): Promise<boolean> {
  const avatarTrigger = page.locator('.avatar-menu .avatar-agent-trigger').first();
  if (await avatarTrigger.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await avatarTrigger.click();
    const openSettings = page.getByTestId('avatar-open-execution-settings').first();
    if (await openSettings.isVisible({ timeout: T.short }).catch(() => false)) {
      await openSettings.click();
      return true;
    }
    // Leave no popover behind for the next attempt to trip over.
    await page.keyboard.press('Escape').catch(() => {});
  }

  const switcherChip = page.getByTestId('inline-model-switcher-chip').first();
  if (await switcherChip.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await switcherChip.click();
    const openSettings = page.getByTestId('inline-model-switcher-open-settings').first();
    if (await openSettings.isVisible({ timeout: T.short }).catch(() => false)) {
      await openSettings.click();
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
  }

  return false;
}

export async function openSettingsDialog(page: Page) {
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
  await ensureEntryRailOpenIfPresent(page);
  const dialog = settingsSurface(page);
  // On the entry, `entry-settings-button` is the rail nav item that carries
  // settings (see EntryNavRail — it calls itself the e2e contract).
  // `entry-settings-menu-trigger` belongs to `EntrySettingsMenu`, which #5517
  // left unrendered — kept last so an older skin still resolves.
  const settingsTrigger = page
    .getByTestId('entry-settings-button')
    .or(page.getByTestId('entry-settings-menu-trigger'))
    .or(page.getByRole('button', { name: OPEN_SETTINGS_LABEL }))
    .first();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await dialog.isVisible().catch(() => false)) return dialog;

    await dismissPrivacyDialog(page);
    await dismissWhatsNewPopup(page);
    if (await settingsTrigger.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await settingsTrigger.evaluate((element: HTMLElement) => element.click());
    } else if (!(await openSettingsFromProjectSurface(page))) {
      // Neither the entry triggers nor the project surface's model popover is
      // on this page — fall back to the aria-label so the failure names the
      // missing trigger rather than timing out on the surface.
      const fallback = page.getByRole('button', { name: OPEN_SETTINGS_LABEL }).first();
      await expect(fallback).toBeVisible({ timeout: T.medium });
      await fallback.evaluate((element: HTMLElement) => element.click());
    }

    // The first click may only have opened a popover. `AvatarMenu`'s trigger is
    // labelled 'Account & settings' (`avatar.title`), which OPEN_SETTINGS_LABEL
    // matches, so on a project surface the chain above lands on the composer's
    // model popover rather than on Settings — its pinned
    // `avatar-open-execution-settings` row is the click that actually routes
    // there. Keep all three follow-throughs in one locator so whichever popover
    // opened gets finished.
    const detailsTrigger = page
      .getByTestId('entry-settings-open-details')
      .or(page.getByTestId('avatar-open-execution-settings'))
      .or(page.getByTestId('inline-model-switcher-open-settings'))
      .first();
    if (await detailsTrigger.isVisible({ timeout: T.short }).catch(() => false)) {
      await detailsTrigger.click();
    }

    await expect
      .poll(
        async () => {
          if (await dialog.isVisible().catch(() => false)) return 'dialog';
          return 'pending';
        },
        { timeout: T.medium },
      )
      .not.toBe('pending')
      .catch(() => {});

    if (await dialog.isVisible().catch(() => false)) return dialog;
  }

  await expect(dialog).toBeVisible({ timeout: T.medium });
  return dialog;
}

export async function sendPrompt(page: Page, prompt: string) {
  const input = page.getByTestId('chat-composer-input');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.click();
  await input.fill(prompt);
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await input.press('Enter');
}

export async function createProjectViaApi(
  page: Page,
  projectId: string,
  name: string,
) {
  const response = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { conversationId: string };
}

export async function gotoProject(page: Page, projectId: string) {
  try {
    await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ERR_ABORTED|frame was detached/i.test(message)) throw error;
  }
  await dismissPrivacyDialog(page);
  await expectWorkspaceReady(page);
}

export async function putAppConfig(page: Page, config: Record<string, unknown>) {
  const response = await page.request.put('/api/app-config', { data: config });
  expect(response.ok(), await response.text()).toBeTruthy();
}

export async function readAppConfig(page: Page) {
  const response = await page.request.get('/api/app-config');
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { config?: Record<string, unknown> };
}

export async function seedBrowserConfig(page: Page, value: Record<string, unknown>) {
  const payload = { key: STORAGE_KEY, config: value };
  await page.addInitScript(
    ({ key, config }) => {
      window.localStorage.setItem(key, JSON.stringify(config));
    },
    payload,
  );
  await page.evaluate(({ key, config }) => {
    window.localStorage.setItem(key, JSON.stringify(config));
  }, payload).catch(() => {
    // Some pre-navigation pages do not expose localStorage yet; the init script above covers the next load.
  });
}
