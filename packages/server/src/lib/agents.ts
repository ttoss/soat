import { db } from '../db';
import { emitEvent, resolveProjectPublicId } from './eventBus';

// Re-export symbols that callers expect from this module.
export {
  createGeneration,
  type GenerationResult,
  submitToolOutputs,
} from './agentGeneration';
export { resolveUrlPathParams } from './agentToolResolver';
export { getTrace, listTraces } from './agentTraces';

// Re-export AgentTool CRUD and types.
export {
  createAgentTool,
  deleteAgentTool,
  getAgentTool,
  listAgentTools,
  type MappedAgentTool,
  updateAgentTool,
} from './agentToolsCrud';

// ── Mapped Types ─────────────────────────────────────────────────────────

export type MappedAgent = {
  id: string;
  projectId: string;
  aiProviderId: string;
  name: string | null;
  instructions: string | null;
  model: string | null;
  toolIds: string[] | null;
  maxSteps: number | null;
  toolChoice: object | null;
  stopConditions: object[] | null;
  activeToolIds: string[] | null;
  stepRules: object[] | null;
  boundaryPolicy: object | null;
  temperature: number | null;
  createdAt: Date;
  updatedAt: Date;
};

// ── Map Functions ────────────────────────────────────────────────────────

const getAgentIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.AiProvider, as: 'aiProvider' },
  ];
};

const mapAgent = (
  agent: InstanceType<typeof db.Agent> & {
    project: InstanceType<typeof db.Project>;
    aiProvider: InstanceType<typeof db.AiProvider>;
  }
): MappedAgent => {
  return {
    id: agent.publicId,
    projectId: agent.project.publicId,
    aiProviderId: agent.aiProvider.publicId,
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    toolIds: agent.toolIds,
    maxSteps: agent.maxSteps,
    toolChoice: agent.toolChoice,
    stopConditions: agent.stopConditions,
    activeToolIds: agent.activeToolIds,
    stepRules: agent.stepRules,
    boundaryPolicy: agent.boundaryPolicy,
    temperature: agent.temperature,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
};

// ── Agent CRUD Helpers ────────────────────────────────────────────────────

type AgentUpdateFields = {
  aiProviderId?: string;
  name?: string | null;
  instructions?: string | null;
  model?: string | null;
  toolIds?: string[] | null;
  maxSteps?: number | null;
  toolChoice?: object | null;
  stopConditions?: object[] | null;
  activeToolIds?: string[] | null;
  stepRules?: object[] | null;
  boundaryPolicy?: object | null;
  temperature?: number | null;
};

const AGENT_SCALAR_FIELDS = [
  'name',
  'instructions',
  'model',
  'toolIds',
  'maxSteps',
  'toolChoice',
  'stopConditions',
  'activeToolIds',
  'stepRules',
  'boundaryPolicy',
  'temperature',
] as const;

const buildAgentUpdates = (
  args: AgentUpdateFields
): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  for (const field of AGENT_SCALAR_FIELDS) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  return updates;
};

const resolveAiProviderDbId = async (
  publicId: string
): Promise<number | null> => {
  const aiProvider = await db.AiProvider.findOne({ where: { publicId } });
  return aiProvider ? (aiProvider as unknown as { id: number }).id : null;
};

// ── Agent CRUD ───────────────────────────────────────────────────────────

export const createAgent = async (args: {
  projectId: number;
  aiProviderId: string;
  name?: string;
  instructions?: string;
  model?: string;
  toolIds?: string[];
  maxSteps?: number;
  toolChoice?: object;
  stopConditions?: object[];
  activeToolIds?: string[];
  stepRules?: object[];
  boundaryPolicy?: object;
  temperature?: number;
}): Promise<MappedAgent | 'ai_provider_not_found'> => {
  const aiProviderId = await resolveAiProviderDbId(args.aiProviderId);
  if (!aiProviderId) return 'ai_provider_not_found';

  const defaults = {
    name: null,
    instructions: null,
    model: null,
    toolIds: null,
    maxSteps: 20,
    toolChoice: null,
    stopConditions: null,
    activeToolIds: null,
    stepRules: null,
    boundaryPolicy: null,
    temperature: null,
  };
  const agent = await db.Agent.create({
    ...defaults,
    ...buildAgentUpdates(args),
    projectId: args.projectId,
    aiProviderId,
  });

  const created = await db.Agent.findOne({
    where: { id: (agent as unknown as { id: number }).id },
    include: getAgentIncludes(),
  });

  const mapped = mapAgent(created as unknown as Parameters<typeof mapAgent>[0]);

  emitEvent({
    type: 'agents.created',
    projectId: args.projectId,
    projectPublicId: (created as unknown as { project: { publicId: string } })
      .project.publicId,
    resourceType: 'agent',
    resourceId: mapped.id,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return mapped;
};

export const listAgents = async (args: {
  projectIds?: number[];
}): Promise<MappedAgent[]> => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agents = await db.Agent.findAll({
    where,
    include: getAgentIncludes(),
    order: [['createdAt', 'DESC']],
  });

  return agents.map((a) => {
    return mapAgent(a as unknown as Parameters<typeof mapAgent>[0]);
  });
};

export const getAgent = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedAgent | 'not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where, include: getAgentIncludes() });
  if (!agent) return 'not_found';

  return mapAgent(agent as unknown as Parameters<typeof mapAgent>[0]);
};

export const updateAgent = async (
  args: {
    projectIds?: number[];
    id: string;
  } & AgentUpdateFields
): Promise<MappedAgent | 'not_found' | 'ai_provider_not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where });
  if (!agent) return 'not_found';

  const updates = buildAgentUpdates(args);

  if (args.aiProviderId !== undefined) {
    const dbId = await resolveAiProviderDbId(args.aiProviderId);
    if (!dbId) return 'ai_provider_not_found';
    updates.aiProviderId = dbId;
  }

  await agent.update(updates);

  const updated = await db.Agent.findOne({
    where: { id: (agent as unknown as { id: number }).id },
    include: getAgentIncludes(),
  });

  const mapped = mapAgent(updated as unknown as Parameters<typeof mapAgent>[0]);

  emitEvent({
    type: 'agents.updated',
    projectId: (agent as unknown as { projectId: number }).projectId,
    projectPublicId: (updated as unknown as { project: { publicId: string } })
      .project.publicId,
    resourceType: 'agent',
    resourceId: mapped.id,
    data: mapped as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return mapped;
};

export const deleteAgent = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<'ok' | 'not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where });
  if (!agent) return 'not_found';

  await db.Actor.update(
    { agentId: null },
    { where: { agentId: agent.id as number } }
  );
  await agent.destroy();

  const agentProjectId = (agent as unknown as { projectId: number }).projectId;

  resolveProjectPublicId({ projectId: agentProjectId }).then(
    (projectPublicId) => {
      emitEvent({
        type: 'agents.deleted',
        projectId: agentProjectId,
        projectPublicId,
        resourceType: 'agent',
        resourceId: args.id,
        data: { id: args.id },
        timestamp: new Date().toISOString(),
      });
    }
  );

  return 'ok';
};
