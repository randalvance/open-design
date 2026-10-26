// @vitest-environment jsdom
//
// Home composer chip → compact model list → click a model. The chip MUST show
// the clicked model.
//
// Every assertion here is on the user-visible chip label, never on whether a
// callback fired: the callback fires today and the chip still does not move.
// The switcher does not own persistence — `App.handleAgentModelChange` does — so
// these specs wire the real merge/persist shape around the component and let the
// new config flow back in as a prop. A bare `vi.fn()` callback would make every
// case below pass while the real client stayed broken.

import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAgentModelChoice } from '../../src/App';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(async () => ({ ok: false, models: [] })),
}));

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'claude',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

/** A local CLI catalog with several same-prefix long ids. */
const cliAgent: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', enabled: true, default: true },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', enabled: true },
    { id: 'claude-fable-5', label: 'claude-fable-5', enabled: true },
    { id: 'claude-opus-4.6', label: 'claude-opus-4.6', enabled: true },
    { id: 'claude-opus-4.7', label: 'claude-opus-4.7', enabled: true },
    { id: 'claude-opus-4.8', label: 'claude-opus-4.8', enabled: true },
  ],
};

/**
 * Mirrors `App.handleAgentModelChange`: merge into the persisted choice, keep a
 * ref as the write-through truth source, and re-render the switcher with the new
 * config. This is the round-trip the chip label actually depends on, and the
 * same round-trip a page reload replays out of the persisted config.
 */
function StatefulSwitcher({
  agents,
  initialConfig,
  compact = true,
  onPersist,
}: {
  agents: AgentInfo[];
  initialConfig?: Partial<AppConfig>;
  compact?: boolean;
  onPersist?: (agentId: string, model: string | undefined) => void;
}) {
  const [config, setConfig] = useState<AppConfig>({ ...baseConfig, ...initialConfig });
  const persistedRef = useRef(config);
  return (
    <InlineModelSwitcher
      config={config}
      agents={agents}
      providerModelsCache={{}}
      compact={compact}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={(agentId, choice) => {
        const current = persistedRef.current;
        const merged = mergeAgentModelChoice(
          current.agentModels?.[agentId] ?? {},
          choice,
        );
        const next: AppConfig = {
          ...current,
          agentModels: { ...(current.agentModels ?? {}), [agentId]: merged },
        };
        persistedRef.current = next;
        onPersist?.(agentId, merged.model);
        setConfig(next);
      }}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  );
}

function chipText(): string {
  return screen.getByTestId('inline-model-switcher-chip').textContent ?? '';
}

function openSwitcher(): HTMLElement {
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  return screen.getByTestId('inline-model-switcher-popover');
}

/** What the picker shows for a catalog name now that the company token is
 *  dropped: `deepseek-v4-pro` → `v4-pro`. Restated here on purpose — the point
 *  of these assertions is the text a user reads, not the helper that makes it. */
function versionOf(label: string): string {
  return label.replace(/^(?:deepseek|claude)-/, '');
}

function compactRow(modelId: string): HTMLElement {
  return screen.getByTestId(`inline-model-switcher-compact-model-${modelId}`);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe('compact home model list — a clicked model reaches the chip', () => {

  it('applies an on-plan model the user clicks', () => {
    // Control case: this passes on the unfixed code. It is what rules out the
    // outside-click/`mousedown` close handler as the cause — if that handler
    // were unmounting the list before the option's click fired, this case would
    // fail too.
    render(<StatefulSwitcher agents={[cliAgent]} />);
    expect(chipText()).toContain(versionOf('deepseek-v4-flash'));

    openSwitcher();
    fireEvent.click(compactRow('deepseek-v4-pro'));

    expect(chipText()).toContain(versionOf('deepseek-v4-pro'));
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('names models by version alone — the brand mark carries the company', () => {
    // Every row in this list already shows the company's logo, so printing
    // `deepseek-`/`claude-` in front of each name spends width on the half of
    // the string that is identical within a company. The chip follows the rows.
    render(<StatefulSwitcher agents={[cliAgent]} />);
    expect(chipText()).toContain('v4-flash');
    expect(chipText()).not.toContain('deepseek');

    const popover = openSwitcher();
    expect(compactRow('deepseek-v4-pro')).toHaveTextContent('v4-pro');
    expect(compactRow('claude-fable-5')).toHaveTextContent('fable-5');
    expect(within(popover).getAllByRole('radio').map((r) => r.textContent ?? '').join('\n'))
      .not.toMatch(/deepseek-|claude-/);
  });

  it('exposes the full model name on hover for same-prefix long ids', () => {
    // Same-prefix OpenRouter variants are indistinguishable once the row is
    // ellipsised; hovering the row must name the exact model it would select.
    const longPrefixAgent: AgentInfo = {
      ...cliAgent,
      models: [
        {
          id: 'openrouter/google/gemini-2.5-pro-preview-06-05',
          label: 'openrouter/google/gemini-2.5-pro-preview-06-05',
          enabled: true,
          default: true,
        },
        {
          id: 'openrouter/google/gemini-2.5-pro-preview-05-06',
          label: 'openrouter/google/gemini-2.5-pro-preview-05-06',
          enabled: true,
        },
      ],
    };
    render(<StatefulSwitcher agents={[longPrefixAgent]} />);
    openSwitcher();

    for (const model of longPrefixAgent.models ?? []) {
      expect(compactRow(model.id).getAttribute('title')).toBe(model.label);
    }
  });

  it('re-selecting the already active model closes the list without changing the chip', () => {
    render(<StatefulSwitcher agents={[cliAgent]} />);
    openSwitcher();
    fireEvent.click(compactRow('deepseek-v4-flash'));

    expect(chipText()).toContain(versionOf('deepseek-v4-flash'));
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('still closes on a click genuinely outside the switcher', () => {
    render(
      <div>
        <StatefulSwitcher agents={[cliAgent]} />
        <button type="button" data-testid="outside">
          outside
        </button>
      </div>,
    );
    openSwitcher();
    fireEvent.mouseDown(screen.getByTestId('outside'));

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('keeps the execution-settings picker applying a model', () => {
    // The non-compact surface the existing portal-class exemption protects. It
    // must keep working: its option list is a `document.body` portal, so its
    // clicks land outside the switcher's wrapper.
    render(<StatefulSwitcher agents={[cliAgent]} compact={false} />);
    openSwitcher();

    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-agent-model-popover',
    );
    fireEvent.mouseDown(modelPopover);
    fireEvent.click(
      within(modelPopover).getByRole('option', { name: new RegExp(versionOf('deepseek-v4-pro')) }),
    );

    expect(chipText()).toContain(versionOf('deepseek-v4-pro'));
    expect(screen.getByTestId('inline-model-switcher-agent-model')).toHaveTextContent(
      versionOf('deepseek-v4-pro'),
    );
  });
});
