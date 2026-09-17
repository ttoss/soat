import type { MemoryRuleEvent } from '@soat/postgresdb';
import { MEMORY_RULE_EVENTS } from '@soat/postgresdb';

/**
 * Everything about a rule that can be judged without touching the database, so
 * the REST route, the formation pre-flight and the lib all reach the same
 * verdict from the same function.
 *
 * `agentId` / `toolId` are presence flags here, not ids: a formation pre-flight
 * runs before a `{ "ref": … }` resolves to anything.
 */
export type MemoryRuleShape = {
  on?: string | null;
  agentId?: string | number | null;
  toolId?: string | number | null;
  action?: string | null;
  presetParameters?: object | null;
  prompt?: string | null;
  aiProviderId?: string | number | null;
  model?: string | null;
  sourceAgentIds?: unknown;
};

const hasHandler = (shape: MemoryRuleShape): boolean => {
  return Boolean(shape.agentId) || Boolean(shape.toolId);
};

const findEventError = (shape: MemoryRuleShape): string | null => {
  if (shape.on === undefined || shape.on === null) {
    return "'on' is required";
  }
  if (!MEMORY_RULE_EVENTS.includes(shape.on as MemoryRuleEvent)) {
    return `'on' must be one of: ${MEMORY_RULE_EVENTS.join(', ')}`;
  }
  // The built-in extractor reads a whole turn. `conversations.message.generated`
  // fires once per persisted assistant reply, which is a conversation-backed
  // subset — a bare `POST /agents/:id/generate` would never extract, silently.
  // A custom handler may bind there because it decides for itself what a
  // message is worth.
  if (shape.on === 'conversations.message.generated' && !hasHandler(shape)) {
    return "the built-in extractor only runs on 'agents.generation.completed'; set agent_id or tool_id to handle 'conversations.message.generated'";
  }
  return null;
};

const findHandlerError = (shape: MemoryRuleShape): string | null => {
  if (shape.agentId && shape.toolId) {
    return 'agent_id and tool_id are mutually exclusive';
  }
  if (shape.action && !shape.toolId) {
    return 'action applies to a tool handler only';
  }
  if (shape.presetParameters && !shape.toolId) {
    return 'preset_parameters applies to a tool handler only';
  }
  return null;
};

/**
 * `prompt` / `ai_provider_id` / `model` configure the built-in extractor's own
 * completion. A handler makes its own model call — or none — so the three would
 * be accepted and ignored, which is the shape this refuses.
 */
const findExtractorOverrideError = (shape: MemoryRuleShape): string | null => {
  if (!hasHandler(shape)) return null;
  for (const [field, value] of [
    ['prompt', shape.prompt],
    ['ai_provider_id', shape.aiProviderId],
    ['model', shape.model],
  ] as const) {
    if (value) {
      return `${field} configures the built-in extractor and cannot be combined with a handler`;
    }
  }
  return null;
};

const findSelectorError = (shape: MemoryRuleShape): string | null => {
  const { sourceAgentIds } = shape;
  if (sourceAgentIds === undefined || sourceAgentIds === null) return null;
  if (
    !Array.isArray(sourceAgentIds) ||
    sourceAgentIds.some((id) => {
      return typeof id !== 'string' || id.trim().length === 0;
    })
  ) {
    return 'source_agent_ids must be an array of agent ids, or null for every agent in the project';
  }
  return null;
};

/**
 * The rule's validation message, or `null` when it is well formed. Returns the
 * first problem rather than a list, matching `validateIngestionRule`.
 */
export const validateMemoryRule = (shape: MemoryRuleShape): string | null => {
  return (
    findHandlerError(shape) ??
    findEventError(shape) ??
    findExtractorOverrideError(shape) ??
    findSelectorError(shape)
  );
};
