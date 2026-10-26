import { describe, expect, it } from 'vitest';
import {
  agentModelIsSelectable,
  defaultAgentModelId,
  effectiveAgentModelChoice,
  effectiveAgentModelId,
  normalizeAgentModelChoice,
} from '../../src/components/agentModelSelection';
import type { AgentInfo } from '../../src/types';

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  version: '1.0.0',
  models: [{ id: 'default', label: 'Default' }, { id: 'gpt-5', label: 'GPT-5' }],
};

describe('agent model selection', () => {
  it('never coerces a saved model choice away', () => {
    const choice = { model: 'custom-codex-model', reasoning: 'high' };
    expect(normalizeAgentModelChoice(codexAgent, choice)).toBeNull();
    expect(effectiveAgentModelChoice(codexAgent, choice)).toEqual(choice);
    expect(effectiveAgentModelId(codexAgent, choice)).toBe('custom-codex-model');
  });

  it('resolves the default sentinel to the first live model', () => {
    const choice = { model: 'default', reasoning: 'default' };
    expect(effectiveAgentModelChoice(codexAgent, choice)).toEqual(choice);
    expect(effectiveAgentModelId(codexAgent, choice)).toBe('default');
    expect(defaultAgentModelId({ ...codexAgent, models: [{ id: 'a', default: true }, { id: 'b' }] })).toBe('a');
  });

  it('skips disabled rows when picking the default', () => {
    const locked: AgentInfo = {
      ...codexAgent,
      models: [
        { id: 'one', label: 'One', enabled: false },
        { id: 'two', label: 'Two', enabled: false, default: true },
      ],
    };
    expect(defaultAgentModelId(locked)).toBeNull();
    expect(effectiveAgentModelChoice(locked, undefined)).toBeUndefined();
  });

  describe('agentModelIsSelectable', () => {
    it('allows any agent any non-empty id, including custom ids', () => {
      expect(agentModelIsSelectable(codexAgent, 'custom-codex-model')).toBe(true);
      expect(agentModelIsSelectable(codexAgent, 'default')).toBe(true);
      expect(agentModelIsSelectable({ id: 'claude', models: [] }, 'anything')).toBe(true);
    });

    it('refuses an empty model id', () => {
      expect(agentModelIsSelectable(codexAgent, '')).toBe(false);
      expect(agentModelIsSelectable(codexAgent, null)).toBe(false);
    });

    // The load-bearing relation: a surface that offers only selectable rows can
    // never offer a pick `normalizeAgentModelChoice` would coerce away.
    it('is at least as strict as normalizeAgentModelChoice', () => {
      for (const id of ['default', 'gpt-5', 'custom']) {
        const coerced = normalizeAgentModelChoice(codexAgent, { model: id }) !== null;
        if (coerced) expect(agentModelIsSelectable(codexAgent, id)).toBe(false);
      }
    });
  });
});
