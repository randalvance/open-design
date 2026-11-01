// @vitest-environment jsdom
/**
 * OPEND-2772 保留一次失败仅一张卡的守卫。
 * 最新 OPEND-2807 / G16：CLI/BYOK 固定联系我们、导出日志、重试；
 * Cloud 固定联系我们、导出日志、重试。旧的额外重试和恢复阶梯已被用户明确撤销。
 * 标题正文仍按批准文案，不随按钮组合改变。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/analytics/events')>();
  return {
    ...actual,
    trackChatPanelClick: vi.fn(),
    trackRunFailedToastSurfaceView: vi.fn(),
    trackRunRecoveryActionClick: vi.fn(),
    trackRunRecoveryActionSurfaceView: vi.fn(),
  };
});

import { ChatPane } from '../../../src/components/ChatPane';
import {
  trackRunRecoveryActionClick,
} from '../../../src/analytics/events';
import type { ChatMessage } from '../../../src/types';

/** 真字典 —— 判据钉在用户看到的那行字上,不钉键名 */
vi.mock('../../../src/i18n', async () => {
  const { zhCN } = await import('../../../src/i18n/locales/zh-CN');
  const dict = zhCN as unknown as Record<string, string>;
  const t = (key: string, vars?: Record<string, string | number>): string => {
    const raw = dict[key] ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => {
      const v = vars[name];
      return v == null ? `{${name}}` : String(v);
    });
  };
  return {
    useI18n: () => ({ locale: 'zh-CN', setLocale: () => undefined, t }),
    useT: () => t,
  };
});

vi.mock('../../../src/components/AssistantMessage', () => ({
  AssistantMessage: ({ message }: { message: ChatMessage }) => (
    <div data-testid={`assistant-${message.id}`}>{message.content}</div>
  ),
}));

vi.mock('../../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((_props, _ref) => <div data-testid="composer" />),
}));

// ⚠️ 故意**不 mock** `AmrGuidance`:这份文件的第一条判据就是「那张卡还在不在」,
// 把它 stub 掉等于把要照的东西糊住。

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 产品文案逐字 —— `promptTemplates.retry` */
const RETRY_CTA = '重试';

function failedMessage(opts: { agentId: string; code: string; detail?: string }): ChatMessage {
  return {
    id: 'msg-failed',
    role: 'assistant',
    content: 'Partial work before the failure.',
    createdAt: 1,
    runId: 'run-failed',
    runStatus: 'failed',
    agentId: opts.agentId,
    events: [
      {
        kind: 'status',
        label: 'error',
        detail: opts.detail ?? 'raw upstream sentence',
        code: opts.code,
      },
    ],
  } as ChatMessage;
}

function renderFailure(opts: {
  agentId: string;
  code: string;
  detail?: string;
  onRetry?: (m: ChatMessage, reason: string) => void;
}) {
  const onRetry = opts.onRetry ?? vi.fn();
  const rendered = render(
    <ChatPane
      messages={[failedMessage(opts)]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={onRetry as never}
      onOpenSettings={vi.fn() as never}
      conversations={[
        { projectId: 'project-1', id: 'conv-1', title: 'Current', createdAt: 1, updatedAt: 1 },
      ]}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    />,
  );
  return { ...rendered, onRetry };
}

/** 卡上那一排里的主按钮(`RunErrorCardAction` 给每颗都盖了 `data-run-error-action`) */
function primaryActions(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-run-error-action="primary"]'),
  );
}

describe('OPEND-2772 · 一次失败只出一张卡', () => {
  it('BYOK 登录过期:第二张切换卡整块不在了', () => {
    const { container } = renderFailure({ agentId: 'claude', code: 'AGENT_AUTH_REQUIRED' });

    expect(screen.getAllByTestId('chat-run-error-card')).toHaveLength(1);
    expect(screen.queryByTestId('amr-guidance')).toBeNull();
    expect(
      container.querySelector('[data-user-action-card="hosted-agent-suggestion"]'),
    ).toBeNull();
  });

  it('那句 CTA 只出现一次 —— 不许卡上一颗、卡下再一张', () => {
    const { container } = renderFailure({ agentId: 'claude', code: 'AGENT_AUTH_REQUIRED' });

    const hits = Array.from(container.querySelectorAll('button')).filter(
      (b) => (b.textContent ?? '').trim() === RETRY_CTA,
    );
    expect(hits).toHaveLength(1);
  });

  it('报错卡自己的文案原封不动 —— 合并没有改写标题/正文', () => {
    renderFailure({ agentId: 'claude', code: 'AGENT_AUTH_REQUIRED' });

    const card = screen.getByTestId('chat-run-error-card');
    expect((card.firstElementChild?.textContent ?? '').trim()).toBe('Claude 尚未登录');
    expect(screen.getByTestId('chat-run-error-description').textContent?.trim()).toBe(
      '请先完成 Claude 的登录，再重新尝试。',
    );
  });
});

describe('OPEND-2807 · CLI/BYOK 主按钮固定重试', () => {
  it('按钮逐字使用工单和 G16 的「重试」', () => {
    renderFailure({ agentId: 'claude', code: 'AGENT_AUTH_REQUIRED' });

    const cta = screen.getByTestId('chat-error-retry');
    expect((cta.textContent ?? '').trim()).toBe(RETRY_CTA);
  });

  it('主按钮就是那颗 CTA,而且整张卡只有一颗主按钮', () => {
    const { container } = renderFailure({ agentId: 'claude', code: 'AGENT_AUTH_REQUIRED' });

    const primaries = primaryActions(container);
    expect(primaries).toHaveLength(1);
    expect((primaries[0]!.textContent ?? '').trim()).toBe(RETRY_CTA);
  });

  it('CLI/BYOK 不再保留旧重试，整张卡只有固定三颗', () => {
    const { container } = renderFailure({ agentId: 'claude', code: 'AGENT_AUTH_REQUIRED' });

    expect(Array.from(screen.getByTestId('chat-run-error-card').querySelectorAll('button'),
      (button) => button.dataset.testid)).toEqual([
      'chat-error-contact-support', 'chat-error-export-logs', 'chat-error-retry',
    ]);
    // 常驻两颗照旧在
    expect(container.querySelector('[data-testid="chat-error-contact-support"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="chat-error-export-logs"]')).toBeTruthy();
  });

  /*
   * 铺开的证据。这四条今天**一条都不出切换卡**:
   *   · S19 进程崩了(每月 20,868 次,第二大桶)—— 落兜底,只有一颗〔重试〕
   *   · S01 没装 CLI
   *   · S13 模型不可用 —— 主按钮是〔更换模型〕(旧 §6.Z 的第 1 档优先)
   *   · S30 网络环境不对 —— 主按钮是〔去设置〕
   * 产品 2026-09-07 把 8-26 那条「第 1 档永远优先」推翻掉了。
   */
  it.each([
    ['S19 进程崩了', 'AGENT_EXECUTION_FAILED', 'process_crashed'],
    ['S01 没装 CLI', 'AGENT_UNAVAILABLE', undefined],
    ['S13 模型不可用', 'AMR_MODEL_UNAVAILABLE', undefined],
    ['S30 网络环境不对', 'AGENT_EXECUTION_FAILED', 'certificate_failure'],
  ] as const)('%s:BYOK 上也有这颗主 CTA', (_name, code, detail) => {
    const { container } = renderFailure({
      agentId: 'claude',
      code,
      ...(detail ? { detail } : {}),
    });

    const primaries = primaryActions(container);
    expect(primaries).toHaveLength(1);
    expect((primaries[0]!.textContent ?? '').trim()).toBe(RETRY_CTA);
  });

  /*
   * `UPSTREAM_UNAVAILABLE` 在映射表里一直写着要出切换卡,却被 `ChatPane` 单独
   * 否掉,**没有任何注释说明理由**。合并之后这条无理由的否决一并消失。
   */
  it('上游过载(此前被无理由否掉的那一类)也有这颗 CTA', () => {
    const { container } = renderFailure({ agentId: 'claude', code: 'UPSTREAM_UNAVAILABLE' });

    const primaries = primaryActions(container);
    expect(primaries).toHaveLength(1);
    expect((primaries[0]!.textContent ?? '').trim()).toBe(RETRY_CTA);
  });

  it('点它走的是现成的重试动作,并且埋点没丢', () => {
    const onRetry = vi.fn();
    const { container } = renderFailure({
      agentId: 'claude',
      code: 'AGENT_AUTH_REQUIRED',
      onRetry,
    });

    fireEvent.click(primaryActions(container)[0]!);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ id: 'msg-failed' });
    expect(
      vi
        .mocked(trackRunRecoveryActionClick)
        .mock.calls.some(
          (call) => call[1]?.recovery_action_type === 'manual_retry',
        ),
    ).toBe(true);
  });
});
