// @vitest-environment jsdom
//
// Settings-entry invariant: exactly one rail settings entry, directly under
// 插件 (per product: 设置的按钮在插件下边). This repo keeps the
// `entry-settings-button` testId the e2e suite contracts on.

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
  it('renders exactly one settings item, below 扩展', () => {
    const onOpenSettings = renderRail();

    expect(screen.getAllByTestId('entry-settings-button')).toHaveLength(1);
    const settings = screen.getByTestId('entry-settings-button');
    expect(testIdAfterPlugins()).toBe('entry-settings-button');
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

});
