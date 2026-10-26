// @vitest-environment jsdom
//
// recvpZCr4MAqNQ: a project's name stayed "未命名" forever, even after its
// first prompt ran and produced real content. Root cause: the Drafts / All-
// projects empty-state "New project" CTA (`EntryShell.startBlankProjectFromRail`)
// created a project with the literal placeholder name and NO `nameSource`
// metadata at all. `canAutoRenameProjectFromPrompt` (utils/projectName.ts)
// only re-engages for `nameSource: 'generated' | 'prompt'` — a project
// missing the field entirely fails closed forever, unlike every other blank/
// no-name create path (`handleCreateProjectFromDesignSystem`, the New Project
// panel's blank pick), which already tag `nameSource: 'generated'`.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';


const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchMock() {
  globalThis.fetch = vi.fn(async () => jsonResponse({ projects: [], plugins: [] })) as typeof fetch;
}

function cliAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'daemon',
    agentId: 'claude-code',
    agentModels: { 'claude-code': { model: 'sonnet' } },
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    theme: 'system',
    ...overrides,
  } as AppConfig;
}

function renderAt(path: string, overrides: Partial<React.ComponentProps<typeof EntryShell>> = {}) {
  window.history.replaceState(null, '', path);
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: baseConfig(),
    agents: [cliAgent()],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onCreateProject: vi.fn(() => Promise.resolve(true)),
    onBeginProjectCreation: () => ({ projectId: 'optimistic-project', rollback: () => undefined }),
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onPersistComposioKey: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );

  return props;
}

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  installFetchMock();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
  vi.unstubAllGlobals();
});

describe('EntryShell local recent projects', () => {
  const localProject = {
    id: 'local-project', name: 'Local project', skillId: null,
    designSystemId: null, createdAt: 1, updatedAt: 1,
  };
  beforeEach(() => {
    // The rail is collapsed (aria-hidden) on a fresh profile; dock it open so
    // role queries can reach its rows.
    window.localStorage.setItem('od.entry.railOpen', 'true');
  });
  afterEach(() => {
    window.localStorage.removeItem('od.entry.railOpen');
  });

  // OPEND-3140: the local shell lists its projects in the rail's 最近项目
  // section, not in a Home grid, and the rail row's menu drives the same
  // rename handler the grid used to.
  it('lists local projects in the rail, not on Home, and renames from the rail row', async () => {
    const props = renderAt('/', { projects: [localProject] });
    const home = screen.getByTestId('entry-view-home');
    const row = await screen.findByTestId('entry-nav-recent-item');
    expect(row.textContent).toContain('Local project');
    expect(home.querySelector('.recent-projects')).toBeNull();
    expect(screen.queryByTestId('recent-projects-strip')).toBeNull();

    fireEvent.click(screen.getByTestId('entry-nav-recent-more'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename' }) as HTMLInputElement;
    expect(input.value).toBe('Local project');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Renamed local project' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(props.onRenameProject).toHaveBeenCalledWith('local-project', 'Renamed local project');
  });

  it('opens the 项目 page from the rail with the local catalogue', async () => {
    renderAt('/', { projects: [localProject] });
    await screen.findByTestId('entry-nav-recent-item');
    fireEvent.click(screen.getByTestId('entry-nav-drafts'));
    expect(window.location.pathname).toBe('/drafts');
    const strip = await screen.findByTestId('recent-projects-strip');
    expect(within(strip).getByText('Local project')).toBeTruthy();
  });

  // OPEND-2793 (product decision B): the community gallery browses without a
  // docked composer until phase three gives it a template-bound shape. The
  // `dock` variant of HomeView stays in the codebase; Community just no longer
  // mounts it, so the grid can use the full page height.
  it('renders the Community gallery without a docked composer', async () => {
    renderAt('/community', { projects: [localProject] });
    await screen.findByTestId('entry-view-home');
    expect(screen.queryByTestId('community-composer-dock')).toBeNull();
    // Home's own composer is still the single composer in the shell.
    expect(screen.getAllByTestId('home-hero-composer-card')).toHaveLength(1);
  });
});

describe('EntryShell blank-project creation tags nameSource', () => {
  it('tags the Drafts empty-state "New project" CTA as generated', async () => {
    const props = renderAt('/drafts');

    const cta = await screen.findByRole('button', { name: 'New project' });
    fireEvent.click(cta);

    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
    expect(props.onCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Untitled',
        metadata: expect.objectContaining({ nameSource: 'generated' }),
      }),
    );
  });

  it('tags the All-projects empty-state "New project" CTA as generated', async () => {
    const props = renderAt('/all-projects');

    const cta = await screen.findByRole('button', { name: 'New project' });
    fireEvent.click(cta);

    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
    expect(props.onCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Untitled',
        metadata: expect.objectContaining({ nameSource: 'generated' }),
      }),
    );
  });
});


describe('empty project catalog completion', () => {
  it('shows the empty state as soon as the local catalog has loaded', async () => {
    renderAt('/drafts');
    await act(async () => {});
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('Create a project here first. It stays private until you move it into the team space.')).toBeTruthy();
  });
});

it('renders a settled catalog failure with retry instead of a loader or an empty success', async () => {
  const onProjectsRefresh = vi.fn(async () => {});
  renderAt('/drafts', { projectsLoadFailed: true, onProjectsRefresh });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Could not load projects');
  expect(screen.queryByText('Loading…')).toBeNull();
  await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
  expect(onProjectsRefresh).toHaveBeenCalledTimes(1);
});
