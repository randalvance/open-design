// @vitest-environment jsdom
//
// OPEND-3140 — the local (CLI / BYOK) shell's entry rail: the 最近项目 section
// fed from the local project list with live run status, the 项目 destination,
// and the local identity row riding the rail's foot dock.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { resetProjectRunStatusStore } from '../../src/hooks/useProjectRunStatuses';
import { I18nProvider } from '../../src/i18n';
import type { Project } from '../../src/types';

function project(id: string, updatedAt: number, name = `Project ${id}`): Project {
  return {
    id,
    name,
    skillId: null,
    designSystemId: null,
    createdAt: updatedAt,
    updatedAt,
  } as Project;
}

type RunFixture = { status: string; awaiting?: boolean };

const RUNS: Record<string, RunFixture> = {
  p1: { status: 'running' },
  p2: { status: 'succeeded', awaiting: true },
  p3: { status: 'failed' },
  p4: { status: 'succeeded' },
};

const originalFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = /^\/api\/runs\?projectId=([^&]+)$/.exec(url);
    if (match) {
      // A local project is read without any Workspace header — the daemon's
      // headerless local branch is what answers.
      const headers = new Headers(init?.headers);
      expect(headers.has('x-od-workspace-id')).toBe(false);
      const id = decodeURIComponent(match[1]!);
      const fixture = RUNS[id];
      const runs = fixture
        ? [{
            id: `run-${id}`,
            projectId: id,
            conversationId: null,
            assistantMessageId: null,
            agentId: 'claude',
            status: fixture.status,
            createdAt: 1,
            updatedAt: 2,
          }]
        : [];
      return new Response(
        JSON.stringify({ runs, awaitingInputProjectIds: fixture?.awaiting ? [id] : [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function renderLocalRail(overrides: Partial<Parameters<typeof EntryNavRail>[0]> = {}) {
  const onViewChange = vi.fn();
  const onOpen = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn(async () => true);
  const onDuplicate = vi.fn(async () => {});
  const onOpenSettings = vi.fn();
  render(
    <I18nProvider initial="en">
      <EntryNavRail
        view="home"
        onViewChange={onViewChange}
        onNewProject={() => {}}
        open
        onOpenSettings={onOpenSettings}
        recentProjects={Array.from({ length: 5 }, (_, index) =>
          project(`p${index + 1}`, 1_000 - index))}
        onOpenRecentProject={onOpen}
        onRenameRecentProject={onRename}
        onDeleteRecentProject={onDelete}
        onDuplicateRecentProject={onDuplicate}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { onViewChange, onOpen, onRename, onDelete, onDuplicate, onOpenSettings };
}

beforeEach(() => {
  window.localStorage.clear();
  resetProjectRunStatusStore();
  stubFetch();
});

afterEach(() => {
  cleanup();
  resetProjectRunStatusStore();
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe('EntryNavRail local shell', () => {
  it('lists the local projects in the 最近项目 section, newest first, with live run status', async () => {
    renderLocalRail();
    const toggle = screen.getByTestId('entry-nav-recent-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = screen.getAllByTestId('entry-nav-recent-item');
    expect(rows.map((row) => row.textContent)).toEqual(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => `Project ${id}`),
    );
    // The same feed and the same display mapping the cloud rail reads.
    await waitFor(() => {
      expect(within(rows[0]!).getByRole('img', { name: 'Running' })).toBeTruthy();
    });
    expect(within(rows[1]!).getByRole('img', { name: 'Needs input' })).toBeTruthy();
    expect(within(rows[2]!).getByRole('img', { name: 'Failed' })).toBeTruthy();
    expect(within(rows[3]!).getByRole('img', { name: 'Completed' })).toBeTruthy();
    expect(within(rows[4]!).queryByRole('img')).toBeNull();
  });

  it('opens a local project through the shell opener and spends its ✓', async () => {
    const { onOpen } = renderLocalRail();
    const rows = screen.getAllByTestId('entry-nav-recent-item');
    await waitFor(() => {
      expect(within(rows[3]!).getByRole('img', { name: 'Completed' })).toBeTruthy();
    });
    fireEvent.click(rows[3]!);
    expect(onOpen).toHaveBeenCalledWith('p4');
    await waitFor(() => {
      expect(within(screen.getAllByTestId('entry-nav-recent-item')[3]!).queryByRole('img')).toBeNull();
    });
  });

  it('offers only the local row actions: rename / duplicate / delete', () => {
    const { onDuplicate } = renderLocalRail();
    fireEvent.click(screen.getAllByTestId('entry-nav-recent-more')[0]!);
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(
      ['Rename', 'Duplicate project', 'Delete'],
    );
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate project' }));
    expect(onDuplicate).toHaveBeenCalledWith('p1');
  });

  it('hides the section when there are no local projects', () => {
    renderLocalRail({ recentProjects: [] });
    expect(screen.queryByTestId('entry-nav-recent-toggle')).toBeNull();
  });

  it('reaches the 项目 destination from the rail', () => {
    const { onViewChange } = renderLocalRail();
    const drafts = screen.getByTestId('entry-nav-drafts');
    expect(drafts.textContent).toContain('All projects');
    fireEvent.click(drafts);
    expect(onViewChange).toHaveBeenCalledWith('drafts');
    // No team catalogue destination.
    expect(screen.queryByTestId('entry-nav-all-projects')).toBeNull();
  });

  it('docks the social links above a local identity row at the rail foot', () => {
    renderLocalRail();
    const dock = screen.getByTestId('entry-nav-local-account-dock');
    expect(within(dock).getByTestId('entry-nav-rail-social')).toBeTruthy();
    expect(within(dock).getByTestId('entry-nav-local-account')).toBeTruthy();
    // No account, no message centre, no sign-in affordance anywhere in the rail.
    expect(screen.queryByTestId('entry-nav-message-center')).toBeNull();
    expect(screen.queryByTestId('entry-nav-account')).toBeNull();
    expect(screen.queryByTestId('workspace-switcher')).toBeNull();
  });

  it('opens Settings from the local identity row', () => {
    const { onOpenSettings } = renderLocalRail();
    fireEvent.click(screen.getByTestId('entry-nav-local-account'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
