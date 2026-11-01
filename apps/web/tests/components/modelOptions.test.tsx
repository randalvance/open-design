// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CUSTOM_MODEL_SENTINEL,
  isCustomModel,
  modelVersionLabel,
  renderModelOptions,
  SearchableModelSelect,
} from '../../src/components/modelOptions';
import type { AgentModelOption } from '../../src/types';

function renderOptions(models: AgentModelOption[]): string {
  return renderToStaticMarkup(<select>{renderModelOptions(models)}</select>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('modelVersionLabel', () => {
  it('drops the company token a brand mark already carries', () => {
    expect(modelVersionLabel('claude-fable-5', 'claude-fable-5')).toBe('fable-5');
    expect(modelVersionLabel('deepseek-v4-pro', 'deepseek-v4-pro')).toBe('v4-pro');
    expect(modelVersionLabel('claude-opus-4.6')).toBe('opus-4.6');
  });

  it('keeps ids whose leading token IS the model family', () => {
    // Stripping here would leave `5` / nothing — a name that identifies no
    // model at all, which is worse than repeating the company.
    expect(modelVersionLabel('gpt-5-mini', 'gpt-5-mini')).toBe('gpt-5-mini');
    expect(modelVersionLabel('grok-4.5', 'grok-4.5')).toBe('grok-4.5');
    expect(modelVersionLabel('o3', 'o3')).toBe('o3');
  });

  it('leaves BYOK provider/model ids and unknown vendors alone', () => {
    expect(modelVersionLabel('anthropic/claude-sonnet-4-5')).toBe(
      'anthropic/claude-sonnet-4-5',
    );
    expect(modelVersionLabel('acme-turbo-1', 'acme-turbo-1')).toBe('acme-turbo-1');
  });

  it('leaves a prose label that does not lead with the company token', () => {
    expect(modelVersionLabel('deepseek-v4-flash', 'DeepSeek V4 Flash')).toBe(
      'DeepSeek V4 Flash',
    );
  });
});

describe('renderModelOptions', () => {
  it('renders an empty model list without options', () => {
    expect(renderOptions([])).toBe('<select></select>');
  });

  it('renders flat model lists as ungrouped options in input order', () => {
    expect(
      renderOptions([
        { id: 'default', label: 'Default' },
        { id: 'sonnet', label: 'Claude Sonnet' },
        { id: 'opus', label: 'Claude Opus' },
      ]),
    ).toBe(
      '<select><option value="default">Default</option><option value="sonnet">Claude Sonnet</option><option value="opus">Claude Opus</option></select>',
    );
  });

  it('pins default and other flat options before provider optgroups', () => {
    expect(
      renderOptions([
        { id: 'openai/gpt-5.1', label: 'openai/gpt-5.1' },
        { id: 'custom-local', label: 'Custom local' },
        { id: 'default', label: 'Default' },
        { id: 'anthropic/claude-sonnet-4.5', label: 'anthropic/claude-sonnet-4.5' },
        { id: 'openai/o3', label: 'openai/o3' },
      ]),
    ).toBe(
      '<select><option value="default">Default</option><option value="custom-local">Custom local</option><optgroup label="openai"><option value="openai/gpt-5.1">gpt-5.1</option><option value="openai/o3">o3</option></optgroup><optgroup label="anthropic"><option value="anthropic/claude-sonnet-4.5">claude-sonnet-4.5</option></optgroup></select>',
    );
  });

  it('treats leading-slash ids as flat and only strips matching provider label prefixes', () => {
    expect(
      renderOptions([
        { id: '/missing-provider', label: '/missing-provider' },
        { id: 'openai/gpt-5.1', label: 'GPT 5.1' },
        { id: 'openai/o3', label: 'openai/o3' },
      ]),
    ).toBe(
      '<select><option value="/missing-provider">/missing-provider</option><optgroup label="openai"><option value="openai/gpt-5.1">GPT 5.1</option><option value="openai/o3">o3</option></optgroup></select>',
    );
  });
});

describe('isCustomModel', () => {
  const models: AgentModelOption[] = [
    { id: 'default', label: 'Default' },
    { id: 'openai/gpt-5.1', label: 'openai/gpt-5.1' },
  ];

  it('returns false for empty selections and listed model ids', () => {
    expect(isCustomModel(null, models)).toBe(false);
    expect(isCustomModel(undefined, models)).toBe(false);
    expect(isCustomModel('', models)).toBe(false);
    expect(isCustomModel('default', models)).toBe(false);
    expect(isCustomModel('openai/gpt-5.1', models)).toBe(false);
  });

  it('returns true for unlisted custom ids and the custom sentinel', () => {
    expect(isCustomModel('local/my-model', models)).toBe(true);
    expect(isCustomModel(CUSTOM_MODEL_SENTINEL, models)).toBe(true);
  });
});


describe('SearchableModelSelect', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 120,
      y: 200,
      top: 200,
      right: 360,
      bottom: 236,
      left: 120,
      width: 240,
      height: 36,
      toJSON: () => ({}),
    });
  });

  it('clamps an upward popover and keeps that placement while it still fits', async () => {
    let triggerRect = {
      x: 120,
      y: 300,
      top: 300,
      right: 360,
      bottom: 336,
      left: 120,
      width: 240,
      height: 36,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => triggerRect,
    );

    render(
      <SearchableModelSelect
        models={Array.from({ length: 9 }, (_, index) => ({
          id: `model-${index}`,
          label: `Model ${index}`,
        }))}
        value="model-0"
        onChange={vi.fn()}
        searchPlaceholder="Search models"
        popoverTestId="model-popover"
        getPopoverBoundary={() => ({
          top: 80,
          right: 500,
          bottom: 400,
          left: 8,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    const popover = await screen.findByTestId('model-popover');
    expect(popover.style.bottom).toBe(`${window.innerHeight - 300 + 6}px`);
    expect(popover.style.maxHeight).toBe('214px');

    triggerRect = {
      ...triggerRect,
      y: 200,
      top: 200,
      bottom: 236,
    };
    fireEvent.scroll(window);

    await waitFor(() => {
      expect(popover.style.bottom).toBe(`${window.innerHeight - 200 + 6}px`);
      expect(popover.style.maxHeight).toBe('114px');
    });
  });

  it('renders capability tag and cost metadata as option text', async () => {
    render(
      <SearchableModelSelect
        models={[
          {
            id: 'deepseek-v4-flash',
            label: 'deepseek-v4-flash',
            metadata: { cost: 'low', capability: 'standard' },
          },
        ]}
        value="deepseek-v4-flash"
        onChange={vi.fn()}
        searchPlaceholder="Search models"
        minSearchableOptions={1}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    // Flat list = a provider's own catalog (BYOK), where the label IS the id
    // the request will carry, so it is shown verbatim. The company-grouped
    // catalog is the surface that shortens it (see the compact-switcher test).
    const option = await screen.findByRole('option', { name: /^deepseek-v4-flash$/ });
    expect(option.textContent).toContain('Low cost');
    expect(option.textContent).toContain('Standard');
    expect(option.getAttribute('aria-labelledby')).toBeTruthy();
    expect(option.getAttribute('aria-describedby')).toBeTruthy();
    expect(option).toHaveAccessibleName('deepseek-v4-flash');
    expect(option).toHaveAccessibleDescription('Low cost Standard');
    expect(option.querySelector('[data-description]')).toBeNull();
    expect(option.querySelector('[data-label]')).toBeNull();
  });

  it('disables unavailable options', async () => {
    const onChange = vi.fn();
    render(
      <SearchableModelSelect
        models={[
          { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', default: true },
          { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', enabled: false },
        ]}
        value="deepseek-v4-flash"
        onChange={onChange}
        searchPlaceholder="Search models"
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    const disabledOption = await screen.findByRole('option', { name: /^deepseek-v4-pro$/ });
    expect(disabledOption.hasAttribute('disabled')).toBe(true);

    fireEvent.click(disabledOption);
    expect(onChange).not.toHaveBeenCalled();
  });



  it('exposes the full model name on hover for same-prefix long ids', async () => {
    // The report: two OpenRouter variants share a prefix, the row label is
    // ellipsised, and no title leaves the two indistinguishable. Hovering any
    // row must reveal the complete name it stands for.
    const models: AgentModelOption[] = [
      {
        id: 'openrouter/google/gemini-2.5-pro-preview-06-05',
        label: 'openrouter/google/gemini-2.5-pro-preview-06-05',
      },
      {
        id: 'openrouter/google/gemini-2.5-pro-preview-05-06',
        label: 'openrouter/google/gemini-2.5-pro-preview-05-06',
      },
    ];
    render(
      <SearchableModelSelect
        models={models}
        value={models[0]!.id}
        onChange={vi.fn()}
        searchPlaceholder="Search models"
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    for (const model of models) {
      const option = await screen.findByRole('option', { name: model.label });
      expect(option.getAttribute('title')).toBe(model.label);
    }
    // The trigger readout truncates the same way, so it carries the full name
    // on hover too.
    expect(screen.getByRole('combobox').getAttribute('title')).toBe(models[0]!.label);
  });

});
