// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { installMockOpenDesignHost } from '@open-design/host/testing';

import { navigate } from '../../src/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import { navigationTiming } from '../../src/observability/navigation-timing';
import { reportSafetyEvent } from '../../src/analytics/error-tracking';
import type { AgentInfo, AppConfig, Project } from '../../src/types';
import {
  fetchComposioConfigFromDaemon,
  fetchDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncComposioConfigToDaemon,
  syncConfigToDaemon,
} from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchPromptTemplates,
  fetchSkills,
  replaceProjectWorkingDir,
  uploadProjectFiles,
} from '../../src/providers/registry';
import {
  createDesignSystemProjectFromProject,
  createProject,
  createPluginShareProject,
  deleteProject,
  duplicateProject,
  getProject,
  listProjects,
  listTemplates,
  patchProject,
  ProjectCreateError,
} from '../../src/state/projects';
import {
  HOME_COMPOSER_ATTACHMENTS_EVENT,
  clearHomeComposerAttachments,
  peekHomeComposerAttachments,
} from '../../src/state/home-composer-stash';
import { resetCoalescedGet } from '../../src/lib/coalesced-get';
const iframePoolHarness = vi.hoisted(() => ({
  evictMatching: vi.fn(),
  evictProject: vi.fn(),
}));

const workspaceTabsHarness = vi.hoisted(() => ({
  projectIds: new Set<string>(),
}));

vi.mock('../../src/components/IframeKeepAlivePool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/components/IframeKeepAlivePool')>()),
  useIframeKeepAlivePool: () => ({
    attach: vi.fn(),
    release: vi.fn(),
    evict: vi.fn(),
    evictProject: iframePoolHarness.evictProject,
    evictMatching: iframePoolHarness.evictMatching,
    subscribe: vi.fn(() => () => {}),
    revision: vi.fn(() => 0),
  }),
}));

vi.mock('../../src/analytics/error-tracking', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/analytics/error-tracking')>(),
  reportSafetyEvent: vi.fn(),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({
    onCreateProject,
    onCreatePluginShareProject,
    onDeleteProject,
    onImportFolderResponse,
    onOpenProject,
    onRenameProject,
    onOpenSettings,
    onRefreshAgents,
    agents,
    projects,
    projectsLoading,
  }: {
    onCreateProject: (input: unknown) => boolean | Promise<boolean>;
    onCreatePluginShareProject: (
      pluginId: string,
      action: 'publish-github' | 'contribute-open-design',
    ) => Promise<unknown>;
    onDeleteProject: (id: string) => void;
    onImportFolderResponse?: (response: {
      conversationId: string;
      entryFile: string | null;
      ok: true;
      projectId: string;
    }) => Promise<void> | void;
    onOpenProject: (
      id: string,
      fileName?: string,
    ) => Promise<boolean> | boolean | void;
    onRenameProject?: (id: string, name: string) => Promise<void> | void;
    onOpenSettings: () => void;
    onRefreshAgents: () => void | Promise<void>;
    agents: AgentInfo[];
    projects: Project[];
    projectsLoading?: boolean;
  }) => (
    <main>
      <div data-testid="entry-home-surface" />
      <div data-testid="entry-projects-loading">{String(Boolean(projectsLoading))}</div>
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(onCreateProject({
            name: 'Fresh project',
            skillId: null,
            designSystemId: null,
            metadata: { kind: 'prototype' },
          })).catch(() => {});
        }}
      >
        Create project
      </button>
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(onCreateProject({
            name: 'Prompted project',
            skillId: null,
            designSystemId: null,
            pendingPrompt: 'Build the retained artifact prompt',
            pendingFiles: [new File(['brief'], 'brief.txt', { type: 'text/plain' })],
            autoSendFirstMessage: true,
            metadata: { kind: 'prototype' },
          })).catch(() => {});
        }}
      >
        Create prompted project
      </button>
      <button
        type="button"
        onClick={() => void onCreatePluginShareProject(
          'plugin-source',
          'publish-github',
        )}
      >
        Create plugin share project
      </button>
      <button
        type="button"
        onClick={() =>
          onCreateProject({
            name: 'Dir project',
            skillId: null,
            designSystemId: null,
            metadata: { kind: 'prototype', userWorkingDir: '/Users/me/external' },
            userWorkingDirToken: 'wd-token',
            pendingFiles: [new File(['hi'], 'note.txt', { type: 'text/plain' })],
          })
        }
      >
        Create project with working dir
      </button>
      <button
        type="button"
        onClick={() =>
          onCreateProject({
            name: 'Many attachment project',
            skillId: null,
            designSystemId: null,
            metadata: { kind: 'prototype', userWorkingDir: '/Users/me/external' },
            userWorkingDirToken: 'wd-token',
            pendingPrompt: 'Make a deck from these',
            autoSendFirstMessage: true,
            pendingFiles: Array.from(
              { length: 6 },
              (_unused, index) =>
                new File([`shot-${index}`], `shot-${index}.png`, { type: 'image/png' }),
            ),
          })
        }
      >
        Create project with many attachments
      </button>
      <button
        type="button"
        onClick={() =>
          onCreateProject({
            name: 'Context dir project',
            skillId: null,
            designSystemId: null,
            metadata: { kind: 'prototype', linkedDirs: ['/Users/me/existing'] },
            linkedDirs: ['/Users/me/reference', ' /Users/me/reference ', '/Users/me/local-code'],
          })
        }
      >
        Create project with context dirs
      </button>
      <button
        type="button"
        onClick={() =>
          void onImportFolderResponse?.({
            conversationId: 'conv-import',
            entryFile: null,
            ok: true,
            projectId: 'project-new',
          })
        }
      >
        Host import folder
      </button>
      <button type="button" onClick={() => void onRefreshAgents()}>
        Refresh agents
      </button>
      <button type="button" onClick={onOpenSettings}>
        Open settings from home
      </button>
      <button type="button" onClick={() => void onOpenProject('project-missing')}>
        Open missing project
      </button>
      <button
        type="button"
        onClick={() => projects[0] && void onRenameProject?.(projects[0].id, 'Rename A')}
      >
        Rename first project A
      </button>
      <button
        type="button"
        onClick={() => projects[0] && void onRenameProject?.(projects[0].id, 'Rename B')}
      >
        Rename first project B
      </button>
      <div data-testid="entry-agent-list">
        {agents.map((agent) => (
          <span key={agent.id} data-testid={`entry-agent-${agent.id}`}>
            {agent.name}
          </span>
        ))}
      </div>
      {projects.map((project) => (
        <div key={project.id} data-testid={`entry-project-${project.id}`}>
          <span>{project.name}</span>
          <button type="button" onClick={() => onOpenProject(project.id)}>
            Open {project.name}
          </button>
          <button type="button" onClick={() => void onDeleteProject(project.id)}>
            Delete {project.name}
          </button>
        </div>
      ))}
    </main>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: ({
    onBack,
    onCreateProjectFromDesignSystem,
    onCreateDesignSystemFromProject,
    onDuplicateProject,
    onProjectsRefresh,
    onProjectChange,
    project,
    routeConversationId,
    onOpenSettings,
    creationHandoff,
    onCreationHandoffSettled,
  }: {
    onBack: () => void;
    onCreateProjectFromDesignSystem?: (designSystemId: string, title: string) => Promise<void> | void;
    onCreateDesignSystemFromProject?: (
      sourceProjectId: string,
      input: { name?: string; pendingPrompt?: string },
    ) => Promise<void> | void;
    onDuplicateProject?: (
      sourceProjectId: string,
      input?: { name?: string },
    ) => Promise<void> | void;
    onProjectsRefresh: () => Promise<void>;
    onProjectChange: (project: Project) => void;
    project: Project;
    routeConversationId?: string | null;
    onOpenSettings?: () => void;
    creationHandoff?: { conversationId?: string | null; persisted: boolean } | null;
    onCreationHandoffSettled?: (projectId: string) => void;
  }) => {
    // The real view releases the creation record once its first transcript
    // settles, which needs reads that wait for the create; the stand-in has
    // no transcript, so it settles as soon as the project is persisted.
    const creationPersisted = creationHandoff?.persisted ?? true;
    useEffect(() => {
      if (creationPersisted) onCreationHandoffSettled?.(project.id);
    }, [creationPersisted, onCreationHandoffSettled, project.id]);
    return (
    <main data-testid="project-view">
      <span data-testid="project-title">{project.name}</span>
      <span data-testid="project-route-conversation">{routeConversationId ?? 'none'}</span>
      <span data-testid="project-creation-phase">
        {creationHandoff ? (creationHandoff.persisted ? 'persisted' : 'pending') : 'none'}
      </span>
      <button type="button" onClick={onBack}>
        Back to projects
      </button>
      <button
        type="button"
        onClick={() => void onCreateDesignSystemFromProject?.(project.id, {
          name: 'Derived design system',
          pendingPrompt: 'Extract the retained design system prompt',
        })}
      >
        Extract design system project
      </button>
      <button
        type="button"
        onClick={() => void onDuplicateProject?.(project.id, {
          name: 'Scoped duplicate',
        })}
      >
        Duplicate project
      </button>
      <button type="button" onClick={onOpenSettings}>
        Open settings from project
      </button>
      <button type="button" onClick={() => void onProjectsRefresh()}>
        Refresh projects
      </button>
      <button
        type="button"
        onClick={() => onProjectChange({
          ...project,
          name: 'After local rename',
          updatedAt: project.updatedAt + 1,
        })}
      >
        Rename current project
      </button>
      <button
        type="button"
        onClick={() => void onCreateProjectFromDesignSystem?.('slack', 'Slack')}
      >
        Create design from design system
      </button>
    </main>
    );
  },
}));

vi.mock('../../src/components/WorkspaceTabsBar', () => ({
  WorkspaceTabsBar: ({
    projects,
  }: {
    projects: Project[];
  }) => (
    <>
      {projects.map((project) => (
        <span key={project.id} data-testid={`workspace-tab-name-${project.id}`}>
          {project.name}
        </span>
      ))}
    </>
  ),
  openWorkspaceTab: (route: { kind: string; projectId?: string }) => {
    if (route.kind === 'project' && route.projectId) {
      workspaceTabsHarness.projectIds.add(route.projectId);
    }
  },
  removeWorkspaceProjectTabs: (projectId: string) => {
    workspaceTabsHarness.projectIds.delete(projectId);
  },
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="settings-surface">
      <button type="button" onClick={onClose}>
        Close settings
      </button>
    </div>
  ),
  switchApiProtocolConfig: (config: AppConfig) => config,
  updateCurrentApiProtocolConfig: (config: AppConfig) => config,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
    replaceProjectWorkingDir: vi.fn(),
    uploadProjectFiles: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createDesignSystemProjectFromProject: vi.fn(),
    createProject: vi.fn(),
    createPluginShareProject: vi.fn(),
    deleteProject: vi.fn(),
    duplicateProject: vi.fn(),
    getProject: vi.fn(),
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
    patchProject: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchDaemonConfig: vi.fn().mockResolvedValue({}),
    fetchComposioConfigFromDaemon: vi.fn().mockResolvedValue(null),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    saveConfig: vi.fn(),
    syncComposioConfigToDaemon: vi.fn().mockResolvedValue(true),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchDesignSystems = vi.mocked(fetchDesignSystems);
const mockedFetchDesignTemplates = vi.mocked(fetchDesignTemplates);
const mockedFetchPromptTemplates = vi.mocked(fetchPromptTemplates);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedUploadProjectFiles = vi.mocked(uploadProjectFiles);
const mockedReplaceProjectWorkingDir = vi.mocked(replaceProjectWorkingDir);
const mockedCreateDesignSystemProjectFromProject = vi.mocked(createDesignSystemProjectFromProject);
const mockedCreateProject = vi.mocked(createProject);
const mockedCreatePluginShareProject = vi.mocked(createPluginShareProject);
const mockedDeleteProject = vi.mocked(deleteProject);
const mockedDuplicateProject = vi.mocked(duplicateProject);
const mockedGetProject = vi.mocked(getProject);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedPatchProject = vi.mocked(patchProject);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);
const mockedFetchComposioConfigFromDaemon = vi.mocked(fetchComposioConfigFromDaemon);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedMergeDaemonConfig = vi.mocked(mergeDaemonConfig);
const mockedSaveConfig = vi.mocked(saveConfig);
const mockedSyncComposioConfigToDaemon = vi.mocked(syncComposioConfigToDaemon);
const mockedSyncConfigToDaemon = vi.mocked(syncConfigToDaemon);

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  privacyDecisionAt: 1778244000000,
  mediaProviders: {},
  composio: {},
  agentModels: {},
  agentCliEnv: {},
};

const freshProject: Project = {
  id: 'project-new',
  name: 'Fresh project',
  skillId: null,
  designSystemId: null,
  createdAt: 1778244000000,
  updatedAt: 1778244000000,
  metadata: { kind: 'prototype' },
};

const existingProject: Project = {
  id: 'project-existing',
  name: 'Existing project',
  skillId: null,
  designSystemId: null,
  createdAt: 1778243000000,
  updatedAt: 1778243000000,
  metadata: { kind: 'prototype' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('App project creation routing', () => {
  beforeEach(() => {
    navigationTiming.cancel('page_exit');
    resetCoalescedGet();
    workspaceTabsHarness.projectIds.clear();
    window.history.replaceState(null, '', '/');
    mockedDaemonIsLive.mockResolvedValue(true);
    mockedFetchAgentsStream.mockResolvedValue([]);
    mockedFetchSkills.mockResolvedValue([]);
    mockedFetchDesignTemplates.mockResolvedValue([]);
    mockedFetchDesignSystems.mockResolvedValue([]);
    mockedFetchPromptTemplates.mockResolvedValue([]);
    mockedFetchAppVersionInfo.mockResolvedValue(null);
    mockedListTemplates.mockResolvedValue([]);
    mockedFetchDaemonConfig.mockResolvedValue({});
    mockedFetchComposioConfigFromDaemon.mockResolvedValue(null);
    mockedMergeDaemonConfig.mockImplementation((local) => local);
    mockedLoadConfig.mockReturnValue({ ...baseConfig });
    mockedUploadProjectFiles.mockResolvedValue({ uploaded: [], failed: [] });
    mockedCreateProject.mockResolvedValue({
      project: freshProject,
      conversationId: 'conv-new',
    });
    mockedCreateDesignSystemProjectFromProject.mockResolvedValue({
      project: {
        ...freshProject,
        id: 'project-design-system',
        name: 'Derived design system',
      },
      conversationId: 'conv-design-system',
      designSystemId: 'derived-design-system',
      copiedFiles: [],
    });
    mockedCreatePluginShareProject.mockResolvedValue({
      ok: true,
      project: {
        ...freshProject,
        id: 'project-plugin-share',
        name: 'Plugin share project',
        pendingPrompt: 'Publish the retained plugin share prompt',
      },
      conversationId: 'conv-plugin-share',
      actionPluginId: 'od-plugin-publish-github',
      sourcePluginId: 'plugin-source',
      stagedPath: 'plugin-source',
      prompt: 'Publish the retained plugin share prompt',
      message: 'Prepared',
    });
    mockedDeleteProject.mockResolvedValue(true);
    mockedDuplicateProject.mockResolvedValue({
      project: {
        ...freshProject,
        id: 'project-duplicate',
        name: 'Scoped duplicate',
      },
      conversationId: 'conv-duplicate',
      copiedFiles: [],
    });
    mockedGetProject.mockResolvedValue(null);
    mockedPatchProject.mockResolvedValue(freshProject);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    navigationTiming.cancel('page_exit');
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetCoalescedGet();
  });

  it('declares Home business Ready after successful empty required catalogs', async () => {
    mockedListProjects.mockResolvedValue([]);
    const signal = vi.fn(async (_value: { readiness_point?: string }) => true);
    const restore = installMockOpenDesignHost({ host: {
      startup: { context: async () => ({ launch_attempt_id: 'launch', app_session_id: 'session' }), signal },
    } });
    try {
      render(<App />);
      await waitFor(() => expect(signal).toHaveBeenCalledWith(expect.objectContaining({ readiness_point: 'interactive_ready' })));
    } finally { restore(); }
  });

  it.each(['projects', 'agents', 'config', 'skills', 'designTemplates', 'designSystems', 'promptTemplates'] as const)('does not declare Home business Ready when required %s fail', async (resource) => {
    mockedListProjects.mockResolvedValue([]);
    if (resource === 'projects') mockedListProjects.mockRejectedValue(new Error('catalog unavailable'));
    else if (resource === 'agents') mockedFetchAgentsStream.mockRejectedValue(new Error('agents unavailable'));
    else if (resource === 'config') mockedFetchDaemonConfig.mockResolvedValue(null);
    else {
      // Exercise the actual provider's failure semantics with the App readiness
      // gates; a mocked rejected promise misses providers that swallow failures.
      const actual = await vi.importActual<typeof import('../../src/providers/registry')>('../../src/providers/registry');
      if (resource === 'skills') mockedFetchSkills.mockImplementation(actual.fetchSkills);
      if (resource === 'designTemplates') mockedFetchDesignTemplates.mockImplementation(actual.fetchDesignTemplates);
      if (resource === 'designSystems') mockedFetchDesignSystems.mockImplementation(actual.fetchDesignSystems);
      if (resource === 'promptTemplates') mockedFetchPromptTemplates.mockImplementation(actual.fetchPromptTemplates);
      const endpoint = { skills: '/api/skills', designTemplates: '/api/design-templates', designSystems: '/api/design-systems', promptTemplates: '/api/prompt-templates' }[resource];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
        new URL(String(input), 'http://d.local').pathname === endpoint
          ? new Response('', { status: 503 }) : Response.json({})
      )));
    }
    const signal = vi.fn(async (_value: { readiness_point?: string }) => true);
    const restore = installMockOpenDesignHost({ host: {
      startup: { context: async () => ({ launch_attempt_id: 'launch', app_session_id: 'session' }), signal },
    } });
    try {
      render(<App />);
      if (resource !== 'config') {
        await waitFor(() => expect(signal).toHaveBeenCalledWith(expect.objectContaining({ readiness_point: 'first_visible' })));
      } else {
        await waitFor(() => expect(mockedFetchDaemonConfig).toHaveBeenCalled());
      }
      await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
      await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
      expect(signal.mock.calls.some(([value]) => value.readiness_point === 'interactive_ready')).toBe(false);
    } finally { restore(); }
  });

  it('auto-picks the first available agent in registry order after streamed probes settle', async () => {
    const codexAgent: AgentInfo = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.80.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const claudeAgent: AgentInfo = {
      id: 'claude',
      name: 'Claude Code',
      bin: 'claude',
      available: true,
      version: '1.0.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    mockedLoadConfig.mockReturnValue({ ...baseConfig, agentId: null });
    mockedListProjects.mockResolvedValue([]);
    mockedFetchAgentsStream.mockImplementation(async ({ onAgent }) => {
      onAgent(codexAgent);
      onAgent(claudeAgent);
      return [codexAgent, claudeAgent];
    });

    render(<App />);

    await waitFor(() => {
      expect(mockedSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'claude' }),
      );
    });
    expect(
      mockedSaveConfig.mock.calls.some(([saved]) => saved.agentId === 'codex'),
    ).toBe(false);
    expect(mockedSyncConfigToDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'claude' }),
    );
  });

  it('ignores stale streamed writes from an older bootstrap after a newer rescan', async () => {
    const staleCodexAgent: AgentInfo = {
      id: 'codex',
      name: 'Stale Codex CLI',
      bin: 'codex',
      available: false,
      version: null,
      models: [],
    };
    const refreshedCodexAgent: AgentInfo = {
      id: 'codex',
      name: 'Fresh Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.80.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const staleBootstrap = deferred<AgentInfo[]>();
    let emitStaleAgent: ((agent: AgentInfo) => void) | null = null;
    mockedFetchAgentsStream
      .mockImplementationOnce(({ onAgent }) => {
        emitStaleAgent = onAgent;
        return staleBootstrap.promise;
      })
      .mockImplementationOnce(async ({ onAgent }) => {
        onAgent(refreshedCodexAgent);
        return [refreshedCodexAgent];
      });
    mockedListProjects.mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh agents' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-agent-codex').textContent).toBe(
        'Fresh Codex CLI',
      );
    });

    await act(async () => {
      emitStaleAgent?.(staleCodexAgent);
      staleBootstrap.resolve([staleCodexAgent]);
      await staleBootstrap.promise;
    });

    expect(screen.getByTestId('entry-agent-codex').textContent).toBe(
      'Fresh Codex CLI',
    );
  });

  it('does not auto-pick from a partial rescan when an older bootstrap settles', async () => {
    const codexAgent: AgentInfo = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.80.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const claudeAgent: AgentInfo = {
      id: 'claude',
      name: 'Claude Code',
      bin: 'claude',
      available: true,
      version: '1.0.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const staleBootstrap = deferred<AgentInfo[]>();
    const rescan = deferred<AgentInfo[]>();
    mockedLoadConfig.mockReturnValue({ ...baseConfig, agentId: null });
    mockedListProjects.mockResolvedValue([]);
    mockedFetchAgentsStream
      .mockReturnValueOnce(staleBootstrap.promise)
      .mockImplementationOnce(({ onAgent }) => {
        onAgent(codexAgent);
        return rescan.promise;
      });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh agents' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-agent-codex').textContent).toBe(
        'Codex CLI',
      );
    });

    await act(async () => {
      staleBootstrap.resolve([]);
      await staleBootstrap.promise;
    });
    await act(async () => {
      rescan.resolve([codexAgent, claudeAgent]);
      await rescan.promise;
    });

    await waitFor(() => {
      expect(mockedSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'claude' }),
      );
    });
    expect(
      mockedSaveConfig.mock.calls.some(([saved]) => saved.agentId === 'codex'),
    ).toBe(false);
  });

  it('keeps auto-pick gated while rescanning from an empty agent state', async () => {
    const codexAgent: AgentInfo = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.80.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const claudeAgent: AgentInfo = {
      id: 'claude',
      name: 'Claude Code',
      bin: 'claude',
      available: true,
      version: '1.0.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const initialProbe = deferred<AgentInfo[]>();
    const rescan = deferred<AgentInfo[]>();
    mockedLoadConfig.mockReturnValue({ ...baseConfig, agentId: null });
    mockedListProjects.mockResolvedValue([]);
    mockedFetchAgentsStream
      .mockReturnValueOnce(initialProbe.promise)
      .mockImplementationOnce(({ onAgent }) => {
        onAgent(codexAgent);
        return rescan.promise;
      });

    render(<App />);

    await waitFor(() => {
      expect(mockedFetchAgentsStream).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      initialProbe.resolve([]);
      await initialProbe.promise;
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh agents' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-agent-codex').textContent).toBe(
        'Codex CLI',
      );
    });

    await act(async () => {
      rescan.resolve([codexAgent, claudeAgent]);
      await rescan.promise;
    });

    await waitFor(() => {
      expect(mockedSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'claude' }),
      );
    });
    expect(
      mockedSaveConfig.mock.calls.some(([saved]) => saved.agentId === 'codex'),
    ).toBe(false);
  });

  it('keeps a newly created project open when the initial project list resolves stale', async () => {
    const bootstrapProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('stores the Home auto-send prompt outside the project projection before a refresh can drop it', async () => {
    mockedListProjects.mockResolvedValue([]);
    mockedCreateProject.mockResolvedValue({
      project: { ...freshProject, name: 'Prompted project' },
      conversationId: 'conv-new',
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));

    await screen.findByTestId('project-view');
    expect(window.sessionStorage.getItem('od:auto-send-first:project-new')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:project-new')).toBe(
      'Build the retained artifact prompt',
    );
  });

  it('mounts the one project view on the click and keeps it through the create (OPEND-3334)', async () => {
    mockedListProjects.mockResolvedValue([]);
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    let requestedProjectId: string | undefined;
    let requestedConversationId: string | undefined;
    mockedCreateProject.mockImplementation((input) => {
      requestedProjectId = (input as typeof input & { id?: string }).id;
      requestedConversationId = (input as typeof input & { conversationId?: string }).conversationId;
      return creation.promise;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));

    const view = await screen.findByTestId('project-view');
    expect(requestedProjectId).toBeTruthy();
    // The seed conversation is minted with the project and sent with the
    // create, so the route names it from the first frame.
    expect(requestedConversationId).toBeTruthy();
    expect(window.location.pathname).toBe(
      `/projects/${requestedProjectId}/conversations/${requestedConversationId}`,
    );
    expect(screen.getByTestId('project-route-conversation').textContent).toBe(requestedConversationId);
    // Reads are held until the create answers.
    expect(screen.getByTestId('project-creation-phase').textContent).toBe('pending');
    expect(screen.queryByTestId('entry-home-surface')).toBeNull();

    creation.resolve({
      project: {
        ...freshProject,
        id: requestedProjectId!,
        name: 'Prompted project',
        pendingPrompt: 'Build the retained artifact prompt',
      },
      conversationId: requestedConversationId!,
    });

    await waitFor(() => {
      expect(screen.getByTestId('project-creation-phase').textContent).not.toBe('pending');
    });
    // Same instance: the create answering does not replace the view.
    expect(screen.getByTestId('project-view')).toBe(view);
    expect(screen.getByTestId('project-title').textContent).toBe('Prompted project');
  });

  it('reads and uploads nothing project-scoped before the create answers', async () => {
    // The optimistic project is not persisted or authorized yet, so NOTHING
    // project-scoped may go out until POST /api/projects answers. The view is
    // mounted from the click; it holds its reads on the creation phase. (The
    // staged files are drawn from local bytes by the optimistic first turn;
    // see w93-2585-pending-surface-attachments.)
    mockedListProjects.mockResolvedValue([]);
    const creation = deferred<{ project: Project; conversationId: string }>();
    let requestedProjectId: string | undefined;
    mockedCreateProject.mockImplementation((input) => {
      requestedProjectId = (input as typeof input & { id?: string }).id;
      return creation.promise;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));

    await screen.findByTestId('project-view');
    expect(screen.getByTestId('project-creation-phase').textContent).toBe('pending');

    // Exact call comparison, not `not.toHaveBeenCalledWith`: an added optional
    // argument would make a negative argument matcher vacuously true.
    const projectScopedCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) =>
        String(input).includes(`/api/projects/${requestedProjectId}`),
      );
    expect(projectScopedCalls).toHaveLength(0);
    expect(mockedUploadProjectFiles).toHaveBeenCalledTimes(0);
    expect(mockedReplaceProjectWorkingDir).toHaveBeenCalledTimes(0);

    creation.resolve({
      project: {
        ...freshProject,
        id: requestedProjectId!,
        name: 'Prompted project',
      },
      conversationId: 'conv-new',
    });
    await screen.findByTestId('project-view');
  });

  it('uploads staged Home attachments concurrently, after the working-dir handoff', async () => {
    // The in-project composer has uploaded one request per file at
    // STAGED_UPLOAD_CONCURRENCY (4) since the staged-attachment work; the Home
    // hand-off still sent one serialized 12-file batch. Six files must
    // therefore open exactly four requests before any of them settles.
    mockedListProjects.mockResolvedValue([]);
    mockedReplaceProjectWorkingDir.mockResolvedValue(undefined as never);
    const releases: Array<() => void> = [];
    mockedUploadProjectFiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ uploaded: [], failed: [] }));
        }),
    );

    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project with many attachments' }),
    );

    await waitFor(() => {
      expect(mockedUploadProjectFiles).toHaveBeenCalledTimes(4);
    });
    // One file per request, so a failure lands on a file instead of a batch.
    expect(
      mockedUploadProjectFiles.mock.calls.map(([, files]) => (files as File[]).length),
    ).toEqual([1, 1, 1, 1]);
    // The working dir still flips before the first byte goes up, otherwise the
    // files land in the managed root and vanish when baseDir moves.
    expect(mockedReplaceProjectWorkingDir.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedUploadProjectFiles.mock.invocationCallOrder[0]!,
    );

    await act(async () => {
      for (const release of releases.splice(0)) release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockedUploadProjectFiles).toHaveBeenCalledTimes(6);
    });
    await act(async () => {
      for (const release of releases.splice(0)) release();
      await Promise.resolve();
    });
    await screen.findByTestId('project-view');
  });

  it('reports a per-file Home attachment failure instead of swallowing it', async () => {
    mockedListProjects.mockResolvedValue([]);
    mockedReplaceProjectWorkingDir.mockResolvedValue(undefined as never);
    mockedUploadProjectFiles.mockImplementation(async (_projectId, files) => {
      const file = (files as File[])[0]!;
      if (file.name === 'shot-2.png') {
        return { uploaded: [], failed: [{ name: file.name, error: 'disk full' }], error: 'disk full' };
      }
      return {
        uploaded: [{ path: file.name, name: file.name, kind: 'image' as const, size: file.size }],
        failed: [],
      };
    });

    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project with many attachments' }),
    );

    await screen.findByTestId('project-view');
    await waitFor(() => {
      expect(mockedUploadProjectFiles).toHaveBeenCalledTimes(6);
    });
    // The five that landed still travel with the first message.
    const staged = JSON.parse(
      window.sessionStorage.getItem('od:auto-send-attachments:project-new') ?? '[]',
    ) as Array<{ name: string }>;
    expect(staged.map((item) => item.name)).toEqual([
      'shot-0.png',
      'shot-1.png',
      'shot-3.png',
      'shot-4.png',
      'shot-5.png',
    ]);
  });

  it('rolls a failed optimistic Home creation back to the preserved Home surface', async () => {
    mockedListProjects.mockResolvedValue([]);
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    let requestedProjectId: string | undefined;
    mockedCreateProject.mockImplementation((input) => {
      requestedProjectId = (input as typeof input & { id?: string }).id;
      return creation.promise;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));
    await screen.findByTestId('project-view');
    expect(workspaceTabsHarness.projectIds.has(requestedProjectId!)).toBe(true);

    creation.reject(new Error('Could not create project'));

    await screen.findByTestId('entry-home-surface');
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByTestId('project-view')).toBeNull();
    expect(screen.queryByTestId(`entry-project-${requestedProjectId}`)).toBeNull();
    expect(workspaceTabsHarness.projectIds.has(requestedProjectId!)).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('Could not create project');
  });

  it('maps a create preparation timeout to a localized retry toast and hands attachments back', async () => {
    mockedListProjects.mockResolvedValue([]);
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    let requestedProjectId: string | undefined;
    mockedCreateProject.mockImplementation((input) => {
      requestedProjectId = (input as typeof input & { id?: string }).id;
      return creation.promise;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));
    await screen.findByTestId('project-view');

    creation.reject(new ProjectCreateError(
      'Project preparation timed out while validating the selected design system. Please try again.',
      504,
      'PROJECT_CREATE_PREPARATION_TIMEOUT',
      true,
      null,
    ));

    await screen.findByTestId('entry-home-surface');
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByTestId('project-view')).toBeNull();
    expect(screen.queryByTestId(`entry-project-${requestedProjectId}`)).toBeNull();
    expect(screen.getByRole('alert').textContent)
      .toContain('Project setup timed out before it could start. Try sending again.');
    // Home remounts on the way back; the staged File objects ride the stash
    // so the retry can resend the same payload.
    expect(peekHomeComposerAttachments().map((file) => file.name)).toEqual(['brief.txt']);
    clearHomeComposerAttachments();
  });

  /*
   * OPEND-2849(产品《报错文案》S28a / S03):首页发送是乐观建项目,建项目请求失败时
   * 用户看到的是 App 这枚回滚 Toast,不是 HomeView 自己的错误块。所以这两格的定稿
   * 要落在这里:请求没到 daemon → S28a;daemon 说未登录(AMR_AUTH_REQUIRED)→ S03。
   * 原始英文报错(`Failed to fetch` / daemon 的 AMR 文案)不许原样露出。
   */
  it.each([
    [
      'S28a: the create request never reached the daemon',
      () => new TypeError('Failed to fetch'),
      'Local connection lost',
      'Can’t reach the Open Design service on this computer right now. Please restart the app.',
      /Failed to fetch/,
    ],
    [
      'S28a: the web proxy could not reach the daemon',
      () => new ProjectCreateError('Could not reach the local OpenDesign service', null, null, true, null),
      'Local connection lost',
      'Can’t reach the Open Design service on this computer right now. Please restart the app.',
      /Could not reach the local OpenDesign service/,
    ],
  ] as const)('maps a failed Home create to the product copy (%s)', async (_label, makeError, title, body, raw) => {
    mockedListProjects.mockResolvedValue([]);
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    mockedCreateProject.mockImplementation(() => creation.promise);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));
    await screen.findByTestId('project-view');

    creation.reject(makeError());

    await screen.findByTestId('entry-home-surface');
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('.od-toast-message')?.textContent).toBe(title);
    expect(alert.querySelector('.od-toast-details')?.textContent).toBe(body);
    expect(alert.textContent).not.toMatch(raw);
    clearHomeComposerAttachments();
  });

  it('hands attachments to an already-mounted Home when the user backed out before the create failed', async () => {
    mockedListProjects.mockResolvedValue([]);
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    mockedCreateProject.mockImplementation(() => creation.promise);
    // Stands in for the mounted page HomeView (EntryView is mocked here): the
    // real listener in HomeView.attachment-stash.test.tsx takes the slot on
    // this event and appends the files to its staged band.
    const handedBack: string[] = [];
    const onHandedBack = () => {
      handedBack.push(...peekHomeComposerAttachments().map((file) => file.name));
      clearHomeComposerAttachments();
    };
    window.addEventListener(HOME_COMPOSER_ATTACHMENTS_EVENT, onHandedBack);
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));
      await screen.findByTestId('project-view');

      // Back during the in-flight create: Home is on screen before the 504.
      // The user leaves through the entry rail — here, the same router
      // navigation that rail click performs.
      act(() => {
        navigate({ kind: 'home', view: 'home' });
      });
      await screen.findByTestId('entry-home-surface');
      expect(handedBack).toEqual([]);

      creation.reject(new ProjectCreateError(
        'Project preparation timed out while loading plugin resources. Please try again.',
        504,
        'PROJECT_CREATE_PREPARATION_TIMEOUT',
        true,
        null,
      ));

      await waitFor(() => expect(handedBack).toEqual(['brief.txt']));
      expect(window.location.pathname).toBe('/');
      expect(screen.getByRole('alert').textContent)
        .toContain('Project setup timed out before it could start. Try sending again.');
      // Consumed by the mounted composer, so nothing is left for a later mount.
      expect(peekHomeComposerAttachments()).toEqual([]);
    } finally {
      window.removeEventListener(HOME_COMPOSER_ATTACHMENTS_EVENT, onHandedBack);
    }
  });

  it('releases a persisted project when attachment setup fails after creation', async () => {
    mockedListProjects.mockResolvedValue([]);
    mockedUploadProjectFiles.mockRejectedValue(new Error('Attachment upload failed'));
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    let requestedProjectId: string | undefined;
    mockedCreateProject.mockImplementation((input) => {
      requestedProjectId = (input as typeof input & { id?: string }).id;
      return creation.promise;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));
    await screen.findByTestId('project-view');

    creation.resolve({
      project: {
        ...freshProject,
        id: requestedProjectId!,
        name: 'Persisted prompted project',
        pendingPrompt: 'Build the retained artifact prompt',
      },
      conversationId: 'conv-new',
    });

    await screen.findByTestId('project-view');
    expect(screen.getByTestId('project-title').textContent).toBe('Persisted prompted project');
    expect(window.location.pathname).toMatch(new RegExp(`^/projects/${requestedProjectId}(/|$)`));
    await waitFor(() => {
      expect(screen.getByTestId('project-creation-phase').textContent).not.toBe('pending');
    });
    expect(workspaceTabsHarness.projectIds.has(requestedProjectId!)).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Attachment upload failed');
  });

  it('stores the plugin-share prompt before its prepared project projection can refresh', async () => {
    mockedListProjects.mockResolvedValue([]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create plugin share project' }));

    await waitFor(() => expect(mockedCreatePluginShareProject).toHaveBeenCalled());
    await screen.findByTestId('project-view');
    expect(window.sessionStorage.getItem('od:auto-send-first:project-plugin-share')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:project-plugin-share')).toBe(
      'Publish the retained plugin share prompt',
    );
  });

  it('routes "create with this design system" through the default design router, not a prototype', async () => {
    mockedListProjects.mockResolvedValue([existingProject]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    await screen.findByTestId('project-view');
    fireEvent.click(screen.getByRole('button', { name: 'Create design from design system' }));

    await waitFor(() => {
      expect(mockedCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Untitled',
          skillId: null,
          designSystemId: 'slack',
          // No prototype assumption: the click binds the hidden default
          // router so the agent asks (via the task-type question-form) what
          // to build, then auto-sends a preset prompt that names the system.
          pluginId: 'od-default',
          conversationMode: 'design',
          pendingPrompt: expect.stringContaining('Slack'),
          pluginInputs: expect.objectContaining({
            prompt: expect.stringContaining('Slack'),
          }),
          metadata: expect.objectContaining({
            kind: 'other',
          }),
        }),
      );
    });

    // The web-prototype scenario and prototype kind must NOT leak in.
    const call = mockedCreateProject.mock.calls.at(-1)?.[0] as
      | { pluginId?: string; metadata?: { kind?: string } }
      | undefined;
    expect(call?.pluginId).not.toBe('example-web-prototype');
    expect(call?.metadata?.kind).not.toBe('prototype');
    expect(window.sessionStorage.getItem('od:auto-send-first:project-new')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:project-new')).toContain('Slack');
  });

  it('stores the extraction prompt when converting an existing project into a design system', async () => {
    mockedListProjects.mockResolvedValue([existingProject]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Extract design system project' }));

    await waitFor(() => {
      expect(mockedCreateDesignSystemProjectFromProject).toHaveBeenCalledWith(
        'project-existing',
        expect.objectContaining({
          pendingPrompt: 'Extract the retained design system prompt',
        }),
      );
    });
    expect(window.sessionStorage.getItem('od:auto-send-first:project-design-system')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:project-design-system')).toBe(
      'Extract the retained design system prompt',
    );
  });

  it('keeps a newly created project open when a post-create refresh resolves stale', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const staleRefreshProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(staleRefreshProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));

    await act(async () => {
      staleRefreshProjects.resolve([]);
      await staleRefreshProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('ignores an older stale project list after a newer response confirms the local project', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const refreshedProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(refreshedProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));

    await act(async () => {
      refreshedProjects.resolve([freshProject]);
      await refreshedProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('does not revive nonlocal projects from an older list after a newer empty refresh', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const createRefreshProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(createRefreshProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    expect(mockedListProjects).toHaveBeenCalledTimes(2);

    await act(async () => {
      createRefreshProjects.resolve([]);
      await createRefreshProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([existingProject]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-home-surface')).toBeTruthy();
      expect(screen.getByTestId('entry-project-project-new').textContent).toContain(
        'Fresh project',
      );
    });
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByTestId('entry-project-project-existing')).toBeNull();
  });

  it('removes a locally deleted project from workspace tabs and ignores a stale list', async () => {
    mockedDeleteProject.mockResolvedValue(true);
    const initialProjects = deferred<Project[]>();
    const staleRefreshProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(initialProjects.promise)
      .mockResolvedValue([freshProject]);

    render(<App />);

    await act(async () => {
      initialProjects.resolve([freshProject]);
      await initialProjects.promise;
    });

    expect(screen.getByTestId('entry-project-project-new').textContent).toContain(
      'Fresh project',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Fresh project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    workspaceTabsHarness.projectIds.add('project-new');
    expect(workspaceTabsHarness.projectIds.has('project-new')).toBe(true);

    const listCallsBeforeRefresh = mockedListProjects.mock.calls.length;
    mockedListProjects.mockReturnValueOnce(staleRefreshProjects.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    expect(mockedListProjects.mock.calls.length).toBeGreaterThan(listCallsBeforeRefresh);

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Fresh project' }));

    await waitFor(() => {
      expect(mockedDeleteProject).toHaveBeenCalledWith('project-new');
      expect(screen.queryByTestId('entry-project-project-new')).toBeNull();
      expect(workspaceTabsHarness.projectIds.has('project-new')).toBe(false);
    });

    await act(async () => {
      staleRefreshProjects.resolve([freshProject]);
      await staleRefreshProjects.promise;
    });

    expect(screen.queryByTestId('entry-project-project-new')).toBeNull();
  });

  it('keeps a host-imported project routable when getProject and the list lag behind', async () => {
    // Desktop import flow (handleImportFolderResponse fallback): the host
    // bridge has already POSTed the import, but `/api/projects/:id` and
    // `/api/projects` are both still catching up. Without a placeholder
    // the stale `[]` list response would drop the just-imported project
    // from state and the route-guard effect would bounce to Home.
    const bootstrapProjects = deferred<Project[]>();
    const importListProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(importListProjects.promise)
      .mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(null);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Host import folder' }));

    await act(async () => {
      importListProjects.resolve([]);
      await importListProjects.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('project-view')).toBeTruthy();
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-view')).toBeTruthy();
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('hydrates a host-import placeholder from an older project list that contains the import', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const importListProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(importListProjects.promise)
      .mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(null);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Host import folder' }));

    await act(async () => {
      importListProjects.resolve([]);
      await importListProjects.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('project-view')).toBeTruthy();
    });
    expect(screen.getByTestId('project-title').textContent).toBe('');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([freshProject]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('does not revive unrelated projects from an older list that hydrates a host import', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const importListProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(importListProjects.promise)
      .mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(null);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Host import folder' }));

    await act(async () => {
      importListProjects.resolve([]);
      await importListProjects.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('project-view')).toBeTruthy();
    });
    expect(screen.getByTestId('project-title').textContent).toBe('');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([freshProject, existingProject]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-project-project-new').textContent).toContain(
        'Fresh project',
      );
    });
    expect(screen.queryByTestId('entry-project-project-existing')).toBeNull();
  });

  it('switches to the picked working dir before uploading staged Home attachments', async () => {
    // Regression for the "picked working dir + staged attachment" case:
    // replaceProjectWorkingDir flips metadata.baseDir to the external folder,
    // so it must run BEFORE uploadProjectFiles — otherwise the staged files
    // land in the temporary managed .od/projects/<id> root and vanish once the
    // working dir flips. Asserting the call order locks the ordering in.
    mockedListProjects.mockResolvedValue([]);
    mockedReplaceProjectWorkingDir.mockResolvedValue(undefined as never);

    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project with working dir' }),
    );

    await waitFor(() => {
      expect(mockedReplaceProjectWorkingDir).toHaveBeenCalledTimes(1);
      expect(mockedUploadProjectFiles).toHaveBeenCalledTimes(1);
    });

    expect(mockedReplaceProjectWorkingDir).toHaveBeenCalledWith(
      'project-new',
      '/Users/me/external',
      'wd-token',
    );
    // Both target the same project id, and the working-dir handoff is ordered
    // strictly before the upload so the files land in the final tree.
    expect(mockedUploadProjectFiles.mock.calls[0]?.[0]).toBe('project-new');
    const replaceOrder = mockedReplaceProjectWorkingDir.mock.invocationCallOrder[0]!;
    const uploadOrder = mockedUploadProjectFiles.mock.invocationCallOrder[0]!;
    expect(replaceOrder).toBeLessThan(uploadOrder);
  });

  it('persists Home context linked dirs into the project create metadata', async () => {
    mockedListProjects.mockResolvedValue([]);

    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project with context dirs' }),
    );

    await waitFor(() => {
      expect(mockedCreateProject).toHaveBeenCalled();
    });
    expect(mockedCreateProject.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          linkedDirs: [
            '/Users/me/existing',
            '/Users/me/reference',
            '/Users/me/local-code',
          ],
        }),
      }),
    );
  });

  it('short-circuits the upload + auto-send when the working-dir handoff fails', async () => {
    // Regression for the swallowed-failure case: the desktop working-dir token
    // has a ~60s TTL, so a slow user (or any rejected POST) makes
    // replaceProjectWorkingDir throw AFTER the project already exists. The old
    // code only logged a warning and then uploaded the staged attachments into
    // the managed root while the user believed their chosen folder was applied.
    // The fix surfaces a create-time error toast AND aborts the rest of the
    // submit path so the first run cannot proceed on a tree the user did not
    // choose.
    mockedListProjects.mockResolvedValue([]);
    mockedReplaceProjectWorkingDir.mockRejectedValue(
      new Error('working-dir token expired'),
    );

    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project with working dir' }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Couldn't apply the chosen folder/i)).toBeTruthy();
    });
    expect(mockedReplaceProjectWorkingDir).toHaveBeenCalledTimes(1);
    // The handoff failed, so the staged attachments must NOT be uploaded into
    // the managed `.od/projects/<id>` root the user did not pick.
    expect(mockedUploadProjectFiles).not.toHaveBeenCalled();
  });

  it('opens a project whose metadata still names a retired workspace', async () => {
    const projectId = 'project-leftover-workspace';
    mockedListProjects.mockResolvedValue([{ ...freshProject, id: projectId, name: 'Leftover', workspaceId: 'ws-retired' }]);
    window.history.replaceState({}, '', `/projects/${projectId}`);
    render(<App />);
    await screen.findByTestId('project-view');
    expect(screen.getByTestId('project-title').textContent).toBe('Leftover');
  });

  it('records leaving during project lookup without cancelling the original open operation', async () => {
    const lookup = deferred<Awaited<ReturnType<typeof getProject>>>();
    mockedListProjects.mockResolvedValue([]);
    mockedGetProject.mockReturnValue(lookup.promise);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open missing project' }));
    await waitFor(() => expect(mockedGetProject).toHaveBeenCalled());
    const attempt = navigationTiming.getSnapshot();
    expect(attempt?.projectId).toBe('project-missing');
    expect(vi.mocked(reportSafetyEvent).mock.calls.some(([name, props]) =>
      name === 'client_navigation_result' && props?.status === 'started')).toBe(true);
    act(() => navigate({ kind: 'home', view: 'settings' }));
    await waitFor(() => expect(navigationTiming.getSnapshot()).toBeNull());
    await act(async () => { lookup.resolve(freshProject); });
    expect(window.location.pathname).toBe('/projects/project-missing');
    const events = vi.mocked(reportSafetyEvent).mock.calls
      .filter(([name]) => name === 'client_navigation_result').map(([, props]) => props);
    // The settings route is measured as its own page switch; assert only the project attempt.
    const projectEvents = events.filter((event) => event?.navigation_id === events[0]?.navigation_id);
    expect(projectEvents.map((event) => event?.status)).toEqual(['started', 'cancelled']);
  });

  it('still opens the project when only its telemetry attempt is cancelled', async () => {
    const lookup = deferred<Awaited<ReturnType<typeof getProject>>>();
    mockedListProjects.mockResolvedValue([]);
    mockedGetProject.mockReturnValue(lookup.promise);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open missing project' }));
    await waitFor(() => expect(mockedGetProject).toHaveBeenCalled());
    act(() => navigationTiming.cancel('superseded'));
    await act(async () => { lookup.resolve({ ...freshProject, id: 'project-missing' }); });
    await waitFor(() => expect(window.location.pathname).toBe('/projects/project-missing'));
  });

  it('gives repeated project clicks new ids without suppressing an earlier lookup', async () => {
    const firstLookup = deferred<Awaited<ReturnType<typeof getProject>>>();
    mockedListProjects.mockResolvedValue([]);
    mockedGetProject.mockReturnValueOnce(firstLookup.promise).mockResolvedValueOnce(null);
    render(<App />);
    const open = await screen.findByRole('button', { name: 'Open missing project' });
    fireEvent.click(open);
    await waitFor(() => expect(mockedGetProject).toHaveBeenCalledTimes(1));
    const firstId = navigationTiming.getSnapshot()?.id;
    fireEvent.click(open);
    await waitFor(() => expect(mockedGetProject).toHaveBeenCalledTimes(2));
    await screen.findByRole('alert');
    await act(async () => { firstLookup.resolve({ ...freshProject, id: 'project-missing' }); });
    expect(window.location.pathname).toBe('/projects/project-missing');
    const events = vi.mocked(reportSafetyEvent).mock.calls
      .filter(([name]) => name === 'client_navigation_result').map(([, props]) => props);
    expect(events.map((event) => event?.status)).toEqual(['started', 'cancelled', 'started', 'failed']);
    expect(events[1]?.navigation_id).toBe(firstId);
    expect(events[2]?.navigation_id).not.toBe(firstId);
  });

  it('surfaces a toast instead of silently bouncing when opening a missing project', async () => {
    mockedListProjects.mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(null);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open missing project' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'This project has been deleted or no longer exists.',
      );
    });
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByTestId('project-view')).toBeNull();
    const events = vi.mocked(reportSafetyEvent).mock.calls
      .filter(([name]) => name === 'client_navigation_result').map(([, props]) => props);
    expect(events.map((event) => event?.status)).toEqual(['started', 'failed']);
    expect(events[1]?.reason).toBe('open_unavailable');
  });

  it('projects a current-view rename into the tab and recent list immediately', async () => {
    mockedListProjects.mockResolvedValue([existingProject]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    await screen.findByTestId('project-view');

    fireEvent.click(screen.getByRole('button', { name: 'Rename current project' }));
    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('After local rename');
      expect(screen.getByTestId('workspace-tab-name-project-existing').textContent).toBe(
        'After local rename',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    await waitFor(() => {
      expect(screen.getByTestId('entry-project-project-existing').textContent).toContain(
        'After local rename',
      );
    });
  });

  it('serializes list renames and rolls repeated failures back to the confirmed name', async () => {
    const firstPatch = deferred<Project | null>();
    const secondPatch = deferred<Project | null>();
    mockedListProjects.mockResolvedValue([existingProject]);
    mockedPatchProject
      .mockImplementationOnce(() => firstPatch.promise)
      .mockImplementationOnce(() => secondPatch.promise);

    render(<App />);
    await screen.findByTestId('entry-project-project-existing');
    fireEvent.click(screen.getByRole('button', { name: 'Rename first project A' }));
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Rename first project B' }));
    await act(async () => Promise.resolve());
    expect(mockedPatchProject).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('entry-project-project-existing').textContent).toContain('Rename B');

    await act(async () => {
      firstPatch.resolve(null);
      await firstPatch.promise;
    });
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('entry-project-project-existing').textContent).toContain('Rename B');

    await act(async () => {
      secondPatch.resolve(null);
      await secondPatch.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId('entry-project-project-existing').textContent).toContain(
        'Existing project',
      );
    });
  });

  it('keeps a newly created renamed project when the project route restores an older all snapshot', async () => {
    const olderProjects: Project[] = [
      {
        ...existingProject,
        id: 'project-old-a',
        name: 'Untitled A',
      },
      {
        ...existingProject,
        id: 'project-old-b',
        name: 'Untitled B',
      },
    ];
    const createdProject: Project = { ...freshProject };
    mockedListProjects.mockResolvedValue(olderProjects);
    mockedCreateProject.mockResolvedValue({
      project: createdProject,
      conversationId: 'conv-new',
    });

    render(<App />);
    await screen.findByTestId('entry-project-project-old-a');

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByTestId('project-view');
    fireEvent.click(screen.getByRole('button', { name: 'Rename current project' }));
    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('After local rename');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    await screen.findByTestId('entry-home-surface');
    expect(screen.getByTestId('entry-project-project-new').textContent).toContain(
      'After local rename',
    );
  });

  it('returns from full-page Settings to the exact project conversation and file route', async () => {
    window.history.replaceState(
      null,
      '',
      '/projects/project-existing/conversations/conv-exact/files/nested%2Fartifact.html',
    );
    mockedListProjects.mockResolvedValue([existingProject]);

    render(<App />);
    await screen.findByTestId('project-view');

    fireEvent.click(screen.getByRole('button', { name: 'Open settings from project' }));
    await screen.findByTestId('settings-surface');
    expect(window.location.pathname).toBe('/settings');

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(
        '/projects/project-existing/conversations/conv-exact/files/nested/artifact.html',
      );
      expect(screen.getByTestId('project-route-conversation').textContent).toBe('conv-exact');
    });
  });

  it('returns home when full-page Settings was opened from home', async () => {
    mockedListProjects.mockResolvedValue([]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings from home' }));
    await screen.findByTestId('settings-surface');

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
      expect(screen.getByTestId('entry-home-surface')).toBeTruthy();
    });
  });

  it('opens the seeded brand extraction conversation after creating a design system', async () => {
    const brandProject: Project = {
      id: 'brand-acme',
      name: 'acme.com Design System',
      skillId: null,
      designSystemId: null,
      createdAt: 1778244000000,
      updatedAt: 1778244000000,
      metadata: { kind: 'brand', importedFrom: 'brand-extraction', brandId: 'acme' },
    };
    window.history.replaceState(null, '', '/design-systems/create');
    mockedListProjects.mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(brandProject);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, _init?: unknown) => {
        if (typeof input === 'string' && input === '/api/brands') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'acme',
              projectId: brandProject.id,
              conversationId: 'conv-brand-acme',
              sourceUrl: 'https://acme.com/',
              status: 'extracting',
            }),
          } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }),
    );

    render(<App />);

    fireEvent.change(await screen.findByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://acme.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue to generation/i }));

    await waitFor(() => {
      expect(screen.getByTestId('project-route-conversation').textContent).toBe('conv-brand-acme');
    });
    expect(window.location.pathname).toBe(`/projects/${brandProject.id}/conversations/conv-brand-acme`);
  });
});
