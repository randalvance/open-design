// @vitest-environment jsdom
//
// Home composer chip → compact model list → click a model. The chip MUST show
// the clicked model.
//
// The reported bug: the owner clicked `claude-opus-4.6` in the compact list and
// the chip stayed on `deepseek-v4-flash`. The list offered a model that is above
// the caller's plan (`enabled: false` from `vela model list --json`) as a plain
// selectable row; the click was accepted, written to config, and then coerced
// straight back by `normalizeAgentModelChoice` + the re-normalization effect in
// `InlineModelSwitcher` — so the click read as a no-op.
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
  agentId: 'amr',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

/** The catalog from the bug report: the two DeepSeek tiers are on the caller's
 *  plan, the Claude tiers are not. `enabled: false` is what `vela model list
 *  --json` reports for a model above the caller's plan. */
const amrAgent: AgentInfo = {
  id: 'amr',
  name: 'AMR (vela)',
  bin: 'amr',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', enabled: true, default: true },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', enabled: true },
    { id: 'claude-fable-5', label: 'claude-fable-5', enabled: false },
    { id: 'claude-opus-4.6', label: 'claude-opus-4.6', enabled: false },
    { id: 'claude-opus-4.7', label: 'claude-opus-4.7', enabled: false },
    { id: 'claude-opus-4.8', label: 'claude-opus-4.8', enabled: false },
  ],
};

/** Same catalog with every model on-plan — the control case. */
const amrAgentAllEnabled: AgentInfo = {
  ...amrAgent,
  models: (amrAgent.models ?? []).map((model) => ({ ...model, enabled: true })),
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

function isOffered(row: HTMLElement): boolean {
  return (
    !(row as HTMLButtonElement).disabled && row.getAttribute('aria-disabled') !== 'true'
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Pins the clock inside/outside the real campaign window — the ONLY lever
 *  left for campaign visibility now that the URL review parameters are gone. */
function mockNow(at: string): void {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at));
}

describe('compact home model list — a clicked model reaches the chip', () => {
  it('never offers a model whose click the chip will not honor', () => {
    // The invariant, stated as the user sees it. Any row the list presents as
    // clickable must move the chip; a row it will not honor must be presented
    // as unavailable with a reason. Today `claude-opus-4.6` (and the other
    // off-plan Claude tiers) are offered as plain rows and clicking them leaves
    // the chip on `deepseek-v4-flash`.
    for (const model of amrAgent.models ?? []) {
      render(<StatefulSwitcher agents={[amrAgent]} />);
      expect(chipText()).toContain(versionOf('deepseek-v4-flash'));

      openSwitcher();
      const row = compactRow(model.id);
      const offered = isOffered(row);
      fireEvent.click(row);

      if (offered) {
        expect(chipText(), `${model.id} was offered as selectable`).toContain(
          versionOf(model.label),
        );
      } else {
        // Refused is fine — silently refused is not. The row must say why.
        expect(
          screen.getByTestId(`inline-model-switcher-compact-model-lock-${model.id}`)
            .textContent,
          `${model.id} was refused without a reason`,
        ).toBeTruthy();
        expect(chipText()).toContain(versionOf('deepseek-v4-flash'));
      }
      cleanup();
    }
  });

  it('applies an on-plan model the user clicks', () => {
    // Control case: this passes on the unfixed code. It is what rules out the
    // outside-click/`mousedown` close handler as the cause — if that handler
    // were unmounting the list before the option's click fired, this case would
    // fail too.
    render(<StatefulSwitcher agents={[amrAgentAllEnabled]} />);
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
    render(<StatefulSwitcher agents={[amrAgentAllEnabled]} />);
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
      ...amrAgentAllEnabled,
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
    render(<StatefulSwitcher agents={[amrAgentAllEnabled]} />);
    openSwitcher();
    fireEvent.click(compactRow('deepseek-v4-flash'));

    expect(chipText()).toContain(versionOf('deepseek-v4-flash'));
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });




  it('still closes on a click genuinely outside the switcher', () => {
    render(
      <div>
        <StatefulSwitcher agents={[amrAgentAllEnabled]} />
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
    render(<StatefulSwitcher agents={[amrAgentAllEnabled]} compact={false} />);
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
