// @vitest-environment jsdom
// L7ukd6xcqoWpo2xJzKdcDPctnvh revision 96: exact approved title/body.
// Real ProjectView -> ChatPane -> RunErrorCard, plus real transcript HTTP parser
// and bounded loader. Peripheral workspace/file services are isolated below.
// Do not replace the copy assertions with dictionary lookups or mock card DOM.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import type { ChatComposer } from '../../src/components/ChatComposer';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig, ChatMessage, Conversation, Project } from '../../src/types';

const streamViaDaemon = vi.fn();
const saveMessage = vi.fn();
const messageReads = vi.fn<() => Response>();
const conversationReads = vi.fn<() => Response>();

vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/runtime/brands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/brands')>()),
  fetchBrands: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/registry')>()),
  deletePreviewComment: vi.fn(), fetchDesignSystem: vi.fn(),
  fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
  fetchPreviewComments: vi.fn().mockResolvedValue([]),
  fetchProjectFiles: vi.fn().mockResolvedValue([]), fetchSkill: vi.fn(), getTemplate: vi.fn(),
  patchPreviewCommentStatus: vi.fn(), upsertPreviewComment: vi.fn(), writeProjectTextFile: vi.fn(),
}));
vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/state/projects')>()),
  // Both listMessages and listConversations remain real, including HTTP
  // classification. A failed list must be tested before a conversation exists.
  createConversation: vi.fn(async () => conversation), deleteConversation: vi.fn(),
  loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }),
  patchConversation: vi.fn(), patchProject: vi.fn(), persistTabsToDaemonNow: vi.fn(),
  saveMessage: (...args: unknown[]) => saveMessage(...args), saveTabs: vi.fn(),
  cacheTabsLocally: (_projectId: string, state: unknown) => state,
}));
vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/Loading', () => ({ CenteredLoader: () => null, Spinner: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__', FileWorkspace: () => null,
}));
vi.mock('../../src/components/ChatComposer', () => ({
  // Only exposes the real ChatPane's composer-disabled projection. Reload tests
  // click the actual history menu/row, never a fabricated callback button.
  ChatComposer: forwardRef<HTMLDivElement, ComponentProps<typeof ChatComposer>>((props, ref) => (
    <div ref={ref}>
      <button data-testid="access-copy-send" disabled={props.sendDisabled || props.inputDisabled}
        onClick={() => void props.onSend('QA explicit send', [], [])}>Send</button>
    </div>
  )),
}));

const project: Project = {
  id: 'access-copy-project', name: 'Access copy project',
  skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1,
};
const conversation: Conversation = {
  id: 'access-copy-conversation', projectId: project.id,
  title: 'Current history', createdAt: 1, updatedAt: 1,
};
const config: AppConfig = {
  mode: 'daemon', apiProtocol: 'openai', apiKey: '', baseUrl: '', model: '',
  agentId: 'claude', agentModels: {}, skillId: null, designSystemId: null,
};
const agents: AgentInfo[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', available: true, models: [] },
];
const failedHistory: ChatMessage[] = [
  { id: 'access-copy-user', role: 'user', content: 'Build the QA page', createdAt: 1 },
  {
    id: 'access-copy-failure', role: 'assistant', content: 'Partial work retained.',
    createdAt: 2, runId: 'access-copy-run', runStatus: 'failed', agentId: 'claude',
    events: [{ kind: 'status', label: 'error', code: 'AGENT_EXECUTION_FAILED',
      detail: 'QA_PROVIDER_CRASH', failureCategory: 'process_exit', failureDetail: 'process_crashed' }],
  },
];
const recoveredHistory: ChatMessage[] = [
  { id: 'recovered-user', role: 'user', content: 'Recovered persisted transcript', createdAt: 1 },
];
const LOAD_TITLE = '对话内容加载失败';
const LOAD_BODY = '暂时无法读取对话内容，请重试。如果再次失败，请联系支持。';
const onOpenSettings = vi.fn();
const onAgentChange = vi.fn();

const RAW_LOAD_ERROR = 'QA_RAW_LOAD_FAILURE /private/project/transcript.db';

function view() {
  return <I18nProvider initial="zh-CN"><ProjectView
    project={project} routeFileName={null} config={config} agents={agents}
    skills={[]} designTemplates={[]} designSystems={[]} daemonLive
    onModeChange={vi.fn()} onAgentChange={onAgentChange} onAgentModelChange={vi.fn()}
    onRefreshAgents={vi.fn()} onOpenSettings={onOpenSettings} onBack={vi.fn()}
    onClearPendingPrompt={vi.fn()} onTouchProject={vi.fn()} onProjectChange={vi.fn()}
    onProjectsRefresh={vi.fn()}
  /></I18nProvider>;
}
async function tick(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
function sendButton() { return screen.getByTestId('access-copy-send') as HTMLButtonElement; }
function expectCard(title: string, body: string) {
  const card = screen.getByTestId('chat-run-error-card');
  expect(within(card).getByText(title, { exact: true })).toBeTruthy();
  expect(within(card).getByTestId('chat-run-error-description').textContent).toBe(body);
}
function reselectCurrentConversation() {
  fireEvent.click(screen.getByTestId('conversation-history-trigger'));
  fireEvent.click(screen.getByTestId(`conversation-select-${conversation.id}`));
}
function temporaryFailure() {
  return Response.json({ error: RAW_LOAD_ERROR }, { status: 503 });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear(); window.sessionStorage.clear();
  messageReads.mockReset().mockImplementation(() => Response.json({ messages: failedHistory }));
  conversationReads.mockReset().mockImplementation(() => Response.json({ conversations: [conversation] }));
  streamViaDaemon.mockReset().mockResolvedValue(undefined);
  saveMessage.mockReset().mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    if (url.pathname === `/api/projects/${project.id}/conversations`) {
      return conversationReads();
    }
    if (url.pathname === `/api/projects/${project.id}/conversations/${conversation.id}/messages`) {
      return messageReads();
    }
    if (url.pathname === `/api/projects/${project.id}`) {
      return Response.json({ project, resolvedDir: '/qa-access-copy-project' });
    }
    return Response.json({});
  }));
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks();
});

describe('approved transcript load failure, including first open with no history', () => {
  it('uses the approved title/body after four real HTTP failures, never raw transport details', async () => {
    messageReads.mockImplementation(temporaryFailure);
    render(view()); await tick();
    expect(messageReads).toHaveBeenCalledTimes(1);
    await tick(3_500);
    expect(messageReads).toHaveBeenCalledTimes(4);
    expectCard(LOAD_TITLE, LOAD_BODY);
    expect(screen.queryByText(RAW_LOAD_ERROR)).toBeNull();
    expect(screen.queryByText('Build the QA page')).toBeNull();
    expect(sendButton().disabled).toBe(true);
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('reselecting the failed conversation really reloads messages, clears the error and never creates a run', async () => {
    messageReads.mockImplementation(temporaryFailure);
    render(view()); await tick(); await tick(3_500);
    expect(messageReads).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('chat-run-error-card')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    messageReads.mockImplementation(() => Response.json({ messages: recoveredHistory }));
    reselectCurrentConversation(); await tick();
    expect(messageReads).toHaveBeenCalledTimes(5);
    expect(screen.getByText('Recovered persisted transcript')).toBeTruthy();
    expect(screen.queryByTestId('chat-run-error-card')).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('a transient 503 recovers automatically without showing a final load failure or creating a task', async () => {
    messageReads.mockImplementationOnce(temporaryFailure)
      .mockImplementation(() => Response.json({ messages: recoveredHistory }));
    render(view()); await tick();
    expect(messageReads).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('chat-run-error-card')).toBeNull();
    await tick(499);
    expect(messageReads).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(messageReads).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Recovered persisted transcript')).toBeTruthy();
    expect(screen.queryByTestId('chat-run-error-card')).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(streamViaDaemon).not.toHaveBeenCalled();
  });

  it('403 uses the same approved load surface without retrying a denied read', async () => {
    messageReads.mockImplementation(() => Response.json({ error: RAW_LOAD_ERROR }, { status: 403 }));
    render(view()); await tick();
    expect(messageReads).toHaveBeenCalledTimes(1);
    expectCard(LOAD_TITLE, LOAD_BODY);
    expect(sendButton().disabled).toBe(true);
    await tick(3_500);
    expect(messageReads).toHaveBeenCalledTimes(1);
    expect(streamViaDaemon).not.toHaveBeenCalled();
  });
});

describe('approved load copy before the first conversation can be selected', () => {
  it('classifies a real conversation-list 503 without leaking transport text or starting a task', async () => {
    conversationReads.mockImplementation(() => Response.json({ error: RAW_LOAD_ERROR }, { status: 503 }));
    render(view()); await tick();

    // No message GET or failed assistant exists: this is the project-level
    // listConversations catch, not the already-covered transcript read catch.
    expect(conversationReads).toHaveBeenCalledTimes(1);
    expect(messageReads).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-run-error-card')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(sendButton());
    expect(screen.queryByTestId('chat-error-retry')).toBeNull();
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
    expectCard(LOAD_TITLE, LOAD_BODY);
    // The real list API adapter intentionally ignores a response error body
    // and throws ProjectConversationsHttpError('conversations 503'). Neither
    // that transport string nor the server payload belongs on the card.
    expect(screen.queryByText('conversations 503')).toBeNull();
    expect(screen.queryByText(RAW_LOAD_ERROR)).toBeNull();
  });

  it('reopening after a list failure reads the recovered list and transcript without retaining the load card', async () => {
    conversationReads.mockImplementationOnce(() => Response.json({ error: RAW_LOAD_ERROR }, { status: 503 }));
    const mounted = render(view()); await tick();
    expect(conversationReads).toHaveBeenCalledTimes(1);
    expect(messageReads).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-run-error-card')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    expect(streamViaDaemon).not.toHaveBeenCalled();

    // Genuine project reopen lifecycle; no manual setState, cache eviction,
    // or fabricated Retry callback. The default next HTTP response succeeds.
    mounted.unmount();
    messageReads.mockImplementation(() => Response.json({ messages: recoveredHistory }));
    render(view()); await tick();
    expect(conversationReads).toHaveBeenCalledTimes(2);
    expect(messageReads).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Recovered persisted transcript')).toBeTruthy();
    expect(screen.queryByTestId('chat-run-error-card')).toBeNull();
    expect(screen.queryByText(LOAD_TITLE)).toBeNull();
    expect(screen.queryByText('conversations 503')).toBeNull();
    expect(sendButton().disabled).toBe(false);
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });
});
