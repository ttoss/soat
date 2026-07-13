import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitEvent, resolveProjectPublicId } from './eventBus';
import { validateOutputSchema } from './outputSchema';
import {
  assertEphemeralTypeSupported,
  type InlineToolDefinition,
  validateToolDefinition,
} from './tools';

const log = createDebug('soat:agents');

export type { InlineToolDefinition };

// Validates every inline tool definition in an agent's `tools` field —
// shared with pipeline steps' inline `tool` via `tools.ts#validateToolDefinition`.
const validateAgentInlineTools = async (args: {
  projectId: number;
  tools: InlineToolDefinition[] | null | undefined;
}): Promise<void> => {
  for (const definition of args.tools ?? []) {
    assertEphemeralTypeSupported(definition);
    await validateToolDefinition({ definition, projectId: args.projectId });
  }
};

// Re-export symbols that callers expect from this module.
export {
  createGeneration,
  type GenerationResult,
  submitToolOutputs,
} from './agentGeneration';
export { resolveUrlArgs } from './agentToolResolver';

// ── Mapped Types ─────────────────────────────────────────────────────────

export type MappedAgent = {
  id: string;
  projectId: string;
  aiProviderId: string;
  name: string | null;
  instructions: string | null;
  model: string | null;
  toolIds: string[] | null;
  tools: InlineToolDefinition[] | null;
  maxSteps: number | null;
  toolChoice: string | object | null;
  stopConditions: object[] | null;
  activeToolIds: string[] | null;
  stepRules: object[] | null;
  boundaryPolicy: object | null;
  temperature: number | null;
  knowledgeConfig: object | null;
  outputSchema: object | null;
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
    tools: agent.tools as InlineToolDefinition[] | null,
    maxSteps: agent.maxSteps,
    toolChoice: agent.toolChoice,
    stopConditions: agent.stopConditions,
    activeToolIds: agent.activeToolIds,
    stepRules: agent.stepRules,
    boundaryPolicy: agent.boundaryPolicy,
    temperature: agent.temperature,
    knowledgeConfig: agent.knowledgeConfig,
    outputSchema: agent.outputSchema,
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
  tools?: InlineToolDefinition[] | null;
  maxSteps?: number | null;
  toolChoice?: string | object | null;
  stopConditions?: object[] | null;
  activeToolIds?: string[] | null;
  stepRules?: object[] | null;
  boundaryPolicy?: object | null;
  temperature?: number | null;
  knowledgeConfig?: object | null;
  outputSchema?: object | null;
  maxContextMessages?: number | null;
  singleSessionPerActor?: boolean;
};

const AGENT_SCALAR_FIELDS = [
  'name',
  'instructions',
  'model',
  'toolIds',
  'tools',
  'maxSteps',
  'toolChoice',
  'stopConditions',
  'activeToolIds',
  'stepRules',
  'boundaryPolicy',
  'temperature',
  'knowledgeConfig',
  'outputSchema',
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
  tools?: InlineToolDefinition[];
  maxSteps?: number;
  toolChoice?: string | object;
  stopConditions?: object[];
  activeToolIds?: string[];
  stepRules?: object[];
  boundaryPolicy?: object;
  temperature?: number;
  knowledgeConfig?: object;
  outputSchema?: object;
  maxContextMessages?: number;
  singleSessionPerActor?: boolean;
}): Promise<MappedAgent> => {
  validateOutputSchema(args.outputSchema);

  const aiProviderId = await resolveAiProviderDbId(args.aiProviderId);
  if (!aiProviderId)
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${args.aiProviderId}' not found.`
    );

  await validateAgentInlineTools({
    projectId: args.projectId,
    tools: args.tools,
  });

  const defaults = {
    name: null,
    instructions: null,
    model: null,
    toolIds: null,
    tools: null,
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
  validateOutputSchema(args.outputSchema);

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where });
  if (!agent)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.id}' not found.`
    );

  if (args.tools !== undefined) {
    await validateAgentInlineTools({
      projectId: (agent as unknown as { projectId: number }).projectId,
      tools: args.tools,
    });
  }

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

const findDependentIds = async (args: {
  agentId: number;
}): Promise<{ generationIds: number[]; traceIds: number[] }> => {
  const [generationRows, traceRows] = await Promise.all([
    db.Generation.findAll({
      where: { agentId: args.agentId },
      attributes: ['id'],
    }),
    db.Trace.findAll({
      where: { agentId: args.agentId },
      attributes: ['id'],
    }),
  ]);

  return {
    generationIds: generationRows.map((row) => {
      return (row as unknown as { id: number }).id;
    }),
    traceIds: traceRows.map((row) => {
      return (row as unknown as { id: number }).id;
    }),
  };
};

// Deletes an agent's generations/traces along with it. Cross-references from
// OTHER agents' rows into the ones being deleted (self-referencing FKs on
// Generation.initiatorGenerationId and Trace.parentTraceId/rootTraceId) are
// nulled out first, since those FKs are RESTRICT.
const forceDeleteAgentWithDependents = async (args: {
  agent: InstanceType<typeof db.Agent>;
  agentId: number;
}): Promise<void> => {
  const { generationIds, traceIds } = await findDependentIds({
    agentId: args.agentId,
  });

  await db.sequelize.transaction(async (transaction) => {
    if (generationIds.length > 0) {
      await db.Generation.update(
        { initiatorGenerationId: null },
        { where: { initiatorGenerationId: generationIds }, transaction }
      );
    }
    if (traceIds.length > 0) {
      await db.Trace.update(
        { parentTraceId: null },
        { where: { parentTraceId: traceIds }, transaction }
      );
      await db.Trace.update(
        { rootTraceId: null },
        { where: { rootTraceId: traceIds }, transaction }
      );
    }

    await db.Generation.destroy({
      where: { agentId: args.agentId },
      transaction,
    });
    await db.Trace.destroy({ where: { agentId: args.agentId }, transaction });
    await args.agent.destroy({ transaction });
  });
};

export const deleteAgent = async (args: {
  projectIds?: number[];
  id: string;
  force?: boolean;
}): Promise<void> => {
  log('deleteAgent: id=%s force=%s', args.id, Boolean(args.force));

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
    if (!args.force) {
      throw new DomainError(
        'AGENT_HAS_DEPENDENTS',
        `Agent '${args.id}' has dependent generations or traces and cannot be deleted.`
      );
    }

    log(
      'deleteAgent: force-cascading id=%s generations=%d traces=%d',
      args.id,
      generationCount,
      traceCount
    );

    await forceDeleteAgentWithDependents({ agent, agentId });
  } else {
    // Actor.agentId is cleared automatically by the DB via onDelete: 'SET NULL' on the FK.
    await agent.destroy();
  }

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
