import type { AgentInfo, AgentModelChoice, AppConfig } from '../types';
import { agentModelDisplayName } from '../utils/agentLabels';
import { apiProtocolAgentId, apiProtocolModelLabel } from '../utils/apiProtocol';

type AgentModelSource =
  | {
      id: AgentInfo['id'];
      models?: Array<{ id: string; enabled?: boolean; default?: boolean }>;
    }
  | null
  | undefined;

export function defaultAgentModelId(agent: AgentModelSource): string | null {
  const models = agent?.models ?? [];
  return (
    models.find((model) => model.default === true && model.enabled !== false)?.id ??
    models.find((model) => model.enabled !== false)?.id ??
    null
  );
}

/**
 * Every locally installed agent's catalog is its own model ids and every entry
 * is selectable, so a configured choice is never coerced away. Kept as the
 * single normalization seam so callers do not re-derive the rule.
 */
export function normalizeAgentModelChoice(
  _agent: AgentModelSource,
  _choice: AgentModelChoice | undefined,
): AgentModelChoice | null {
  return null;
}

export function effectiveAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  return normalizeAgentModelChoice(agent, choice) ?? choice;
}

export function effectiveAgentModelId(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): string | null {
  const configuredModel = effectiveAgentModelChoice(agent, choice)?.model?.trim();
  return configuredModel && configuredModel !== 'default'
    ? configuredModel
    : defaultAgentModelId(agent);
}

/**
 * Whether `modelId` may be OFFERED to the user as a selectable model.
 *
 * This is the single definition of "locked" for every model-list surface — the
 * home composer's compact list, the execution-settings picker, and the project
 * composer's `AvatarMenu` list all ask it instead of re-deriving the rule.
 * Every installed agent's list is its own model ids and stays fully
 * selectable, so the only unselectable value is an empty one. The predicate
 * stays AT LEAST as strict as `normalizeAgentModelChoice`, so a surface that
 * gates its rows on it can never offer a pick that then gets silently
 * reverted.
 */
export function agentModelIsSelectable(
  _agent: AgentModelSource,
  modelId: string | null | undefined,
): boolean {
  return Boolean(modelId);
}

/**
 * Who a turn sent right now would be answered by: the identity stamped on the
 * assistant placeholder of a real turn and of the optimistic first turn a
 * Home send draws (OPEND-3334). One resolution, so the role row reads the
 * same on both sides of that hand-off.
 */
export function selectedAssistantIdentity(
  config: AppConfig,
  agents: readonly AgentInfo[],
): { agentId: string | undefined; agentName: string | undefined } {
  if (config.mode === 'daemon') {
    const selectedAgent = config.agentId
      ? agents.find((agent) => agent.id === config.agentId) ?? null
      : null;
    const selectedChoice = config.agentId ? config.agentModels?.[config.agentId] : undefined;
    const effectiveChoice = effectiveAgentModelChoice(selectedAgent, selectedChoice);
    return {
      agentId: config.agentId ?? undefined,
      agentName: agentModelDisplayName(config.agentId, selectedAgent?.name, effectiveChoice?.model),
    };
  }
  return {
    agentId: apiProtocolAgentId(config.apiProtocol),
    agentName: apiProtocolModelLabel(config.apiProtocol, config.model),
  };
}
