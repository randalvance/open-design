// @vitest-environment jsdom
//
// Settings-entry invariant: exactly one RAIL settings entry.
//
// History: 飞书 recvq4hGF7BJkI ("Personal 用户，左侧栏有 2 个设置入口") removed
// the rail's own settings item because EntryShell's footer carried an
// `entry-settings-chip` for the same condition. #5517 then dropped that footer
// chip, so the rail item is back as the ONLY settings entry, under 插件 (per
// product: 设置的按钮在插件下边). (Upstream #5971 restored the same entry as
// `entry-nav-settings`; this repo keeps the `entry-settings-button` testId the
// e2e suite contracts on.)

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

function renderRail(onOpenSettings = vi.fn()) {
  render(
    <I18nProvider initial="en">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        onOpenSettings={onOpenSettings}
      />
    </I18nProvider>,
  );
  return onOpenSettings;
}

afterEach(() => {
  cleanup();
});

/** The rail item that follows 插件 in the destination column, by testId. */
function testIdAfterPlugins(): string | null {
  const items = Array.from(document.querySelectorAll('.entry-nav-rail__btn'));
  const pluginsIndex = items.findIndex(
    (el) => el.getAttribute('data-testid') === 'entry-nav-plugins',
  );
  if (pluginsIndex < 0) return null;
  return items[pluginsIndex + 1]?.getAttribute('data-testid') ?? null;
}

describe('EntryNavRail settings entry', () => {

  it('renders exactly one rail settings item, directly under 插件', () => {
    const onOpenSettings = renderRail();
    const settings = screen.getAllByTestId('entry-settings-button');
    expect(settings).toHaveLength(1);
    // Under 插件, above 最近项目: a destination, not an account-menu row.
    const group = settings[0]!.closest('.entry-nav-rail__team-section');
    expect(group).not.toBeNull();
    expect(group?.querySelector('[data-testid="entry-nav-plugins"]')).not.toBeNull();
    // Directly under 插件 (per product: 设置的按钮在插件下边); there is no account
    // menu, so the count stays exactly one.
    expect(testIdAfterPlugins()).toBe('entry-settings-button');
    fireEvent.click(settings[0]!);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
