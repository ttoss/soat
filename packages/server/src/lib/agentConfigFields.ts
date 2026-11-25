import type { AgentRunAs } from './agentRunAs';
import type { AgentToolBinding } from './agentToolBindings';
import { DEFAULT_TIMEZONE, requireTimezone } from './instructionTemplates';

export type AgentUpdateFields = {
  aiProviderId?: string | null;
  modelRouteId?: string | null;
  name?: string | null;
  instructions?: string | null;
  model?: string | null;
  toolBindings?: AgentToolBinding[] | null;
  maxSteps?: number | null;
  toolChoice?: string | object | null;
  stopConditions?: object[] | null;
  activeToolIds?: string[] | null;
  stepRules?: object[] | null;
  policyIds?: string[] | null;
  runAs?: AgentRunAs;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  reasoning?: object | null;
  knowledgeConfig?: object | null;
  outputSchema?: object | null;
  promptCaching?: object | null;
  citationConfig?: object | null;
  maxContextMessages?: number | null;
  singleSessionPerActor?: boolean;
  guardrailIds?: string[] | null;
  traceContentMode?: string | null;
  onApprovalExpiry?: string | null;
  timezone?: unknown;
};

/**
 * Every agent config column a write copies verbatim; `toolBindings` goes
 * through binding normalization instead. `agentConfigEnforcement.test.ts`
 * holds each to a place that acts on it.
 */
export const AGENT_SCALAR_FIELDS = [
  'name',
  'instructions',
  'model',
  'maxSteps',
  'toolChoice',
  'stopConditions',
  'activeToolIds',
  'stepRules',
  'policyIds',
  'runAs',
  'temperature',
  'maxOutputTokens',
  'reasoning',
  'knowledgeConfig',
  'outputSchema',
  'promptCaching',
  'citationConfig',
  'maxContextMessages',
  'singleSessionPerActor',
  'guardrailIds',
  'traceContentMode',
  'onApprovalExpiry',
  'timezone',
] as const;

export const buildAgentUpdates = (
  args: AgentUpdateFields
): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  for (const field of AGENT_SCALAR_FIELDS) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  if (args.timezone !== undefined) {
    updates.timezone = requireTimezone({
      value: args.timezone,
      field: 'timezone',
    });
  }
  return updates;
};

/** Column defaults applied to a new agent, before the caller's own fields. */
export const AGENT_CREATE_DEFAULTS = {
  name: null,
  instructions: null,
  model: null,
  maxSteps: 20,
  toolChoice: null,
  stopConditions: null,
  activeToolIds: null,
  stepRules: null,
  policyIds: null,
  runAs: 'caller',
  temperature: null,
  maxOutputTokens: null,
  reasoning: null,
  promptCaching: null,
  citationConfig: null,
  maxContextMessages: null,
  onApprovalExpiry: null,
  timezone: DEFAULT_TIMEZONE,
};
