// @vitest-environment jsdom
/**
 * A saved comment handed to the agent is written 'applying' when its send is
 * queued, which is before any run exists. These cases pin the other half of
 * that reservation: every way a queued send can end without a run puts the
 * comments it carried back to 'open', so the comment list shows them again.
 *
 * The runs that do start, and then fail or are stopped, are pinned in
 * `ProjectView.api-empty-response.test.tsx`. The harness here is the one from
 * `opend-2614-send-paints-before-preflight.test.tsx`, because the paths in
 * question sit behind the OpenDesign Cloud pre-run gate and the send queue.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildWorkspacePermissions, buildWorkspaceSeatSummary, type WorkspaceCollabContext } from '../helpers/workspace-context';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../../src/components/ProjectView';
import { streamViaDaemon } from '../../src/providers/daemon';
import {
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
} from '../../src/state/projects';
import {
  deletePreviewComment,
  fetchPreviewComments,
  fetchProjectFiles,
  patchPreviewCommentStatus,
} from '../../src/providers/registry';
import { fetchBrands } from '../../src/runtime/brands';
import type {
  AgentInfo,
  AppConfig,
  ChatCommentAttachment,
  ChatMessage,
  Conversation,
  DesignSystemSummary,
  PreviewComment,
  Project,
  SkillSummary,
} from '../../src/types';

const PROJECT_ID = 'comment-release-project';
const TEAM_WORKSPACE = 'nt3itfm1b95puq5w33tvzu44';
const TEAM_MEMBER = 'member-sender';
const PROMPT = 'draft a landing page';

const CALLER_CONTEXT: WorkspaceCollabContext = {
  workspaceId: TEAM_WORKSPACE,
  workspaceType: 'team',
  workspaceMemberId: TEAM_MEMBER,
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'active',
  planId: 'team_pro',
  providerMode: 'platform_credits',
  seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 2 }),
  permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
} as WorkspaceCollabContext;

const savedCommentAttachment = vi.hoisted(
  () => ({
    id: 'comment-1',
    order: 1,
    filePath: 'index.html',
    elementId: 'hero-title',
    selector: '#hero-title',
    label: 'Hero title',
    comment: 'Make this clearer',
    currentText: 'Old title',
    pagePosition: { x: 0, y: 0, width: 100, height: 24 },
    htmlHint: '<h1 id="hero-title">Old title</h1>',
    source: 'saved-comment',
  }) as ChatCommentAttachment,
);

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'zh-CN', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/router', () => ({ navigate: vi.fn() }));

vi.mock('../../src/providers/anthropic', () => ({ streamMessage: vi.fn() }));




vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  listProjectRuns: vi.fn().mockResolvedValue([]),
  publishDaemonRunFinishedEvent: vi.fn(),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));


vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));


vi.mock('../../src/runtime/brands', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/brands')>(
    '../../src/runtime/brands',
  );
  return { ...actual, fetchBrands: vi.fn().mockResolvedValue([]) };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn().mockResolvedValue([]),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(),
    getTemplate: vi.fn(),
    patchPreviewCommentStatus: vi.fn(),
    upsertPreviewComment: vi.fn(),
    writeProjectTextFile: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createConversation: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    persistTabsToDaemonNow: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__',
  FileWorkspace: (props: {
    previewComments?: PreviewComment[];
    onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[]) => unknown;
  }) => (
    <div
      data-testid="file-workspace"
      data-preview-comments={(props.previewComments ?? [])
        .map((comment) => `${comment.id}:${comment.status}`)
        .join(',')}
    >
      <button
        type="button"
        data-testid="send-comment-to-chat"
        onClick={() => void props.onSendBoardCommentAttachments?.([savedCommentAttachment])}
      >
        send to chat
      </button>
    </div>
  ),
}));
vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

/**
 * The real ChatPane brings half the app with it. This stand-in reports the
 * queue and the in-progress state, and exposes the queue row actions.
 */
vi.mock('../../src/components/ChatPane', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/components/ChatPane')>()),
  ChatPane: (props: {
    messages?: ChatMessage[];
    streaming?: boolean;
    sendDisabled?: boolean;
    onStop?: () => void;
    queuedItems?: Array<{
      id: string;
      prompt: string;
      attachments?: [];
      commentAttachments?: ChatCommentAttachment[];
    }>;
    onRemoveQueuedSend?: (id: string) => void;
    onUpdateQueuedSend?: (
      id: string,
      update: { prompt: string; attachments: []; commentAttachments: ChatCommentAttachment[] },
    ) => void;
    onSend?: (
      prompt: string,
      attachments: [],
      commentAttachments: ChatCommentAttachment[],
    ) => unknown;
  }) => {
    const firstQueued = props.queuedItems?.[0];
    return (
      <div>
        <div data-testid="streaming">{props.streaming ? 'yes' : 'no'}</div>
        <div data-testid="queued-count">{props.queuedItems?.length ?? 0}</div>
        <button
          type="button"
          data-testid="normal-send"
          disabled={props.sendDisabled}
          onClick={() => props.onSend?.(PROMPT, [], [])}
        >
          send
        </button>
        <button
          type="button"
          data-testid="send-with-comment"
          disabled={props.sendDisabled}
          onClick={() => props.onSend?.(PROMPT, [], [savedCommentAttachment])}
        >
          send with comment
        </button>
        <button type="button" data-testid="stop" onClick={() => props.onStop?.()}>
          stop
        </button>
        <button
          type="button"
          data-testid="remove-first-queued"
          onClick={() => {
            if (firstQueued) props.onRemoveQueuedSend?.(firstQueued.id);
          }}
        >
          remove queued
        </button>
        <button
          type="button"
          data-testid="strip-comments-from-first-queued"
          onClick={() => {
            if (!firstQueued) return;
            props.onUpdateQueuedSend?.(firstQueued.id, {
              prompt: firstQueued.prompt,
              attachments: [],
              commentAttachments: [],
            });
          }}
        >
          edit queued
        </button>
      </div>
    );
  },
}));

const mockedStreamViaDaemon = vi.mocked(streamViaDaemon);
const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedFetchBrands = vi.mocked(fetchBrands);
const mockedPatchPreviewCommentStatus = vi.mocked(patchPreviewCommentStatus);
const mockedDeletePreviewComment = vi.mocked(deletePreviewComment);

/** AMR on a daemon runtime — 报告里的那套配置(Agent 为 OpenDesign)。 */
const config: AppConfig = {
  mode: 'daemon',
  apiProtocol: 'openai',
  apiKey: '',
  baseUrl: '',
  model: 'deepseek-v4-flash',
  agentId: 'amr',
  skillId: null,
  designSystemId: null,
};

const conversation = (projectId: string): Conversation => ({
  id: `conv-${projectId}`,
  projectId,
  title: null,
  createdAt: 1,
  updatedAt: 1,
});

const project = (): Project => ({
  id: PROJECT_ID,
  name: 'Caustic Pool',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
  metadata: { kind: 'prototype' },
  workspaceId: TEAM_WORKSPACE,
});

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/workspace/context')) {
        return new Response(JSON.stringify({ context: CALLER_CONTEXT }), { status: 200 });
      }
      if (url.includes('/workspace-scope')) {
        return new Promise<Response>(() => {});
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

function renderProjectView() {
  return render(
    <ProjectView
      project={project()}
      routeFileName={null}
      config={config}
      agents={[{ id: 'amr', name: 'amr', available: true }] as unknown as AgentInfo[]}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={[] as DesignSystemSummary[]}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onRefreshAgents={vi.fn()}
      onOpenSettings={vi.fn()}
      onBack={vi.fn()}
      onClearPendingPrompt={vi.fn()}
      onTouchProject={vi.fn()}
      onProjectChange={vi.fn()}
      onProjectsRefresh={vi.fn()}
    />,
  );
}

const CONVERSATION_ID = `conv-${PROJECT_ID}`;

const savedComment: PreviewComment = {
  id: 'comment-1',
  projectId: PROJECT_ID,
  conversationId: CONVERSATION_ID,
  filePath: 'index.html',
  elementId: 'hero-title',
  selector: '#hero-title',
  label: 'Hero title',
  text: 'Old title',
  position: { x: 0, y: 0, width: 100, height: 24 },
  htmlHint: '<h1 id="hero-title">Old title</h1>',
  note: 'Make this clearer',
  status: 'open',
  createdAt: 1,
  updatedAt: 1,
};





function listedComments() {
  return screen.getByTestId('file-workspace').getAttribute('data-preview-comments');
}

function writtenStatuses() {
  return mockedPatchPreviewCommentStatus.mock.calls.map((call) => call[3]);
}

async function renderWithSavedComment() {
  renderProjectView();
  await waitFor(() => expect(listedComments()).toBe('comment-1:open'));
  await waitFor(() =>
    expect((screen.getByTestId('normal-send') as HTMLButtonElement).disabled).toBe(false),
  );
}

async function sendCommentToChat() {
  fireEvent.click(screen.getByTestId('send-comment-to-chat'));
  await waitFor(() => expect(listedComments()).toBe('comment-1:applying'));
}

async function expectCommentReleasedToOpen() {
  await waitFor(() => expect(listedComments()).toBe('comment-1:open'));
  expect(mockedPatchPreviewCommentStatus).toHaveBeenLastCalledWith(
    PROJECT_ID,
    CONVERSATION_ID,
    'comment-1',
    'open',
  );
  expect(writtenStatuses()).not.toContain('failed');
  expect(writtenStatuses()).not.toContain('needs_review');
  expect(mockedDeletePreviewComment).not.toHaveBeenCalled();
  expect(mockedStreamViaDaemon).not.toHaveBeenCalled();
}

describe('a saved comment whose queued send never becomes a run', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    stubFetch();
    mockedListConversations.mockImplementation(async (projectId: string) => [
      conversation(projectId),
    ]);
    mockedCreateConversation.mockImplementation(async (projectId: string) =>
      conversation(projectId),
    );
    mockedListMessages.mockResolvedValue([]);
    mockedFetchProjectFiles.mockResolvedValue([]);
    mockedFetchBrands.mockResolvedValue([]);
    mockedStreamViaDaemon.mockResolvedValue(undefined);
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
    // The registry double keeps the one status the daemon would hold, so a
    // refresh reads back whatever was written last.
    let storedStatus: PreviewComment['status'] = 'open';
    mockedFetchPreviewComments.mockImplementation(async () => [
      { ...savedComment, status: storedStatus },
    ]);
    mockedPatchPreviewCommentStatus.mockImplementation(
      async (_project, _conversation, _id, status) => {
        storedStatus = status;
        return { ...savedComment, status };
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('control: holds the comment as applying once its run starts', async () => {
    await renderWithSavedComment();

    await sendCommentToChat();

    await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
    expect(listedComments()).toBe('comment-1:applying');
    expect(writtenStatuses()).not.toContain('open');
  });






  describe('while an earlier run keeps the send waiting in the queue', () => {
    async function queueCommentBehindRunningTurn() {
      await renderWithSavedComment();
      fireEvent.click(screen.getByTestId('normal-send'));
      await waitFor(() => expect(mockedStreamViaDaemon).toHaveBeenCalledTimes(1));
      await sendCommentToChat();
      await waitFor(() => expect(screen.getByTestId('queued-count').textContent).toBe('1'));
      mockedStreamViaDaemon.mockClear();
    }

    it('returns the comment to open when the user removes the send from the queue', async () => {
      await queueCommentBehindRunningTurn();

      fireEvent.click(screen.getByTestId('remove-first-queued'));

      await waitFor(() => expect(screen.getByTestId('queued-count').textContent).toBe('0'));
      await expectCommentReleasedToOpen();
    });

    it('returns the comment to open when an edit takes it off the queued send', async () => {
      await queueCommentBehindRunningTurn();

      fireEvent.click(screen.getByTestId('strip-comments-from-first-queued'));

      await expectCommentReleasedToOpen();
      expect(screen.getByTestId('queued-count').textContent).toBe('1');
    });

    it('control: keeps the comment applying while its send only waits for the running turn', async () => {
      await queueCommentBehindRunningTurn();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(listedComments()).toBe('comment-1:applying');
      expect(writtenStatuses()).not.toContain('open');
    });
  });

});
