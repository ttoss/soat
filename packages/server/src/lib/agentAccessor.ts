/**
 * The agent's two shapes — the loaded DB row and the mapped wire object — and
 * the scoped accessor between them.
 *
 * Shared by `agents.ts` (CRUD + mapping) and `agentDelete.ts` (the cascade), so
 * neither has to import the other — splitting the 120-line delete out of the
 * CRUD module is only free of a new cycle because the accessor lives here.
 */
import { db } from '../db';
import type { WireAgentToolBinding } from './agentToolBindings';
import type { ResourceIncludes } from './modelIncludes';
import type { ActiveRelease } from './releaseAssignment';
import { makeResourceAccessor } from './resourceAccessor';
import type { InlineToolDefinition } from './tools';

export type MappedAgent = {
  id: string;
  project_id: string;
  /** Null when the agent resolves its model through `model_route_id` instead. */
  ai_provider_id: string | null;
  /** Null when the agent pins a provider through `ai_provider_id` instead. */
  model_route_id: string | null;
  name: string | null;
  instructions: string | null;
  model: string | null;
  tool_bindings: WireAgentToolBinding[] | null;
  tool_ids: string[] | null;
  tools: InlineToolDefinition[] | null;
  max_steps: number | null;
  tool_choice: string | object | null;
  stop_conditions: object[] | null;
  active_tool_ids: string[] | null;
  step_rules: object[] | null;
  boundary_policy: object | null;
  temperature: number | null;
  knowledge_config: object | null;
  output_schema: object | null;
  max_context_messages: number | null;
  single_session_per_actor: boolean;
  trace_content_mode: string | null;
  guardrail_ids: string[] | null;
  /** Current config version; starts at 1 and bumps on every config change. */
  version: number;
  /** Staged rollout in progress, or null when all traffic serves this config. */
  active_release: ActiveRelease | null;
  created_at: Date;
  updated_at: Date;
};

export const getAgentIncludes = (): ResourceIncludes => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.AiProvider, as: 'aiProvider' },
    { model: db.ModelRoute, as: 'modelRoute' },
  ];
};

export type AgentRow = InstanceType<typeof db.Agent> & {
  project: InstanceType<typeof db.Project>;
  aiProvider: InstanceType<typeof db.AiProvider> | null;
  modelRoute: InstanceType<typeof db.ModelRoute> | null;
};

export const agents = makeResourceAccessor<AgentRow>({
  model: () => {
    return db.Agent;
  },
  includes: getAgentIncludes,
  label: 'Agent',
});
