import { db } from '../db';
import { DomainError } from '../errors';
import { emitEvent, resolveProjectPublicId } from './eventBus';

// Re-export symbols that callers expect from this module.
export {
  createGeneration,
  type GenerationResult,
  submitToolOutputs,
} from './agentGeneration';
export { resolveUrlPathParams } from './agentToolResolver';

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
  knowledgeConfig: object | null;
  maxContextMessages: number | null;
  singleSessionPerActor: boolean;
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
    knowledgeConfig: agent.knowledgeConfig,
    maxContextMessages: agent.maxContextMessages,
    singleSessionPerActor: agent.singleSessionPerActor,
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
  knowledgeConfig?: object | null;
  maxContextMessages?: number | null;
  singleSessionPerActor?: boolean;
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
  'knowledgeConfig',
  'maxContextMessages',
  'singleSessionPerActor',
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
  knowledgeConfig?: object;
  maxContextMessages?: number;
  singleSessionPerActor?: boolean;
}): Promise<MappedAgent> => {
  const aiProviderId = await resolveAiProviderDbId(args.aiProviderId);
  if (!aiProviderId)
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found.`
    );

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
    maxContextMessages: null,
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
}): Promise<MappedAgent> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where, include: getAgentIncludes() });
  if (!agent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.id}' not found.`
    );

  return mapAgent(agent as unknown as Parameters<typeof mapAgent>[0]);
};

export const updateAgent = async (
  args: {
    projectIds?: number[];
    id: string;
  } & AgentUpdateFields
): Promise<MappedAgent> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where });
  if (!agent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.id}' not found.`
    );

  const updates = buildAgentUpdates(args);

  if (args.aiProviderId !== undefined) {
    const dbId = await resolveAiProviderDbId(args.aiProviderId);
    if (!dbId)
      throw new DomainError(
        'AI_PROVIDER_NOT_FOUND',
        `AI provider '${args.aiProviderId}' not found.`
      );
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
}): Promise<void> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where });
  if (!agent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.id}' not found.`
    );

  const agentId = (agent as unknown as { id: number }).id;

  const [generationCount, traceCount] = await Promise.all([
    db.Generation.count({ where: { agentId } }),
    db.Trace.count({ where: { agentId } }),
  ]);

  if (generationCount > 0 || traceCount > 0) {
    throw new DomainError(
      'AGENT_HAS_DEPENDENTS',
      `Agent '${args.id}' has dependent generations or traces and cannot be deleted.`
    );
  }

  // Actor.agentId is cleared automatically by the DB via onDelete: 'SET NULL' on the FK.
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
};
