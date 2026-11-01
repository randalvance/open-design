// @vitest-environment jsdom
//
// Placement contract for the update-ready rocket: the local shell keeps it in
// the top-right cluster, and the cluster is absent while the updater is idle.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { UpdaterPopup } from '../../src/components/UpdaterPopup';
import { I18nProvider } from '../../src/i18n';

function idleStatus(): OpenDesignHostUpdaterStatusSnapshot {
  return {
    arch: 'arm64',
    capabilities: {
      canApplyInPlace: false,
      canDownload: true,
      canOpenInstaller: true,
      requiresManualInstall: true,
    },
    channel: 'beta',
    currentVersion: '0.16.2-beta.145',
    enabled: true,
    mode: 'package-launcher',
    platform: 'darwin',
    state: 'idle',
    supported: true,
  };
}

function downloadedStatus(): OpenDesignHostUpdaterStatusSnapshot {
  return {
    ...idleStatus(),
    availableVersion: '0.16.2-beta.146',
    downloadPath: '/tmp/open-design-updater/Open Design Beta.dmg',
    state: 'downloaded',
  };
}

function renderRail() {
  return render(
    <I18nProvider initial="zh-CN">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        updaterSlot={<UpdaterPopup />}
      />
    </I18nProvider>,
  );
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [] })),
  );
}

let restoreHost: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  stubFetch();
});

afterEach(() => {
  cleanup();
  restoreHost?.();
  restoreHost = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderWithDownloadedUpdate() {
  restoreHost = installMockOpenDesignHost({
    host: { updater: { status: vi.fn(async () => downloadedStatus()) } },
  });
  const view = renderRail();
  await screen.findByTestId('entry-nav-updater');
  return view;
}

describe('updater rocket placement', () => {
  it('keeps the rocket in the top-right cluster without an account capsule', async () => {
    await renderWithDownloadedUpdate();

    const rocket = screen.getByTestId('entry-nav-updater');
    expect(screen.queryByTestId('entry-nav-account')).toBeNull();
    await waitFor(() => expect(rocket.closest('.entry-top-right-cluster')).not.toBeNull());
    expect(rocket.closest('.entry-nav-rail__footer')).toBeNull();
  });

  it('keeps the top-right cluster absent while the updater is idle', async () => {
    restoreHost = installMockOpenDesignHost({
      host: { updater: { status: vi.fn(async () => idleStatus()) } },
    });

    renderRail();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('entry-nav-updater')).toBeNull();
    expect(screen.queryByTestId('entry-nav-account-updater')).toBeNull();
    expect(screen.queryByTestId('entry-top-right-github')).toBeNull();
    expect(document.querySelector('.entry-top-right-cluster')).toBeNull();
  });
});
