import { db } from '../db';
import { DomainError } from '../errors';

export type PersistedGeneration = {
  id: string;
  projectId: number;
  agentId: string;
  traceId: string;
  initiatorGenerationId: string | null;
  startedByPrincipalType: string | null;
  startedByPrincipalId: string | null;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  lastActivityAt: Date | null;
  stopReason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

const mapGeneration = (
  gen: InstanceType<(typeof db)['Generation']> & {
    agent?: InstanceType<(typeof db)['Agent']>;
    trace?: InstanceType<(typeof db)['Trace']>;
    initiatorGeneration?: InstanceType<(typeof db)['Generation']> | null;
  }
): PersistedGeneration => {
  if (!gen.agent || !gen.trace) {
    throw new Error('Generation associations are required for serialization.');
  }

  return {
    id: gen.publicId,
    projectId: gen.projectId,
    agentId: gen.agent.publicId,
    traceId: gen.trace.publicId,
    initiatorGenerationId: gen.initiatorGeneration?.publicId ?? null,
    startedByPrincipalType: gen.startedByPrincipalType,
    startedByPrincipalId: gen.startedByPrincipalId,
    status: gen.status,
    startedAt: gen.startedAt,
    completedAt: gen.completedAt,
    lastActivityAt: gen.lastActivityAt,
    stopReason: gen.stopReason,
    metadata: gen.metadata,
    createdAt: gen.createdAt,
    updatedAt: gen.updatedAt,
  };
};

const findInitiatorGeneration = async (args: {
  initiatorGenerationId?: string | null;
  projectId: number;
}) => {
  if (!args.initiatorGenerationId) {
    return null;
  }

  const initiatorGeneration = await db.Generation.findOne({
    where: {
      publicId: args.initiatorGenerationId,
      projectId: args.projectId,
    },
  });

  if (!initiatorGeneration) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${args.initiatorGenerationId}' not found.`
    );
  }

  return initiatorGeneration;
};

const findOrCreateTrace = async (args: {
  traceId: string;
  projectId: number;
  agentDbId: number;
}) => {
  const existingTrace = await db.Trace.findOne({
    where: { publicId: args.traceId, projectId: args.projectId },
  });

  if (existingTrace) {
    return existingTrace;
  }

  return db.Trace.create({
    publicId: args.traceId,
    projectId: args.projectId,
    agentId: args.agentDbId,
    fileId: null,
    stepCount: 0,
    parentTraceId: null,
    rootTraceId: null,
  });
};

export const createGenerationRecord = async (args: {
  publicId: string;
  projectId: number;
  agentId: string;
  traceId: string;
  initiatorGenerationId?: string | null;
  startedByPrincipalType?: string | null;
  startedByPrincipalId?: string | null;
}) => {
  const [agent, initiatorGeneration] = await Promise.all([
    db.Agent.findOne({
      where: { publicId: args.agentId, projectId: args.projectId },
    }),
    findInitiatorGeneration({
      initiatorGenerationId: args.initiatorGenerationId,
      projectId: args.projectId,
    }),
  ]);

  if (!agent) {
    throw new DomainError(
      'AGENT_NOT_FOUND',
      `Agent '${args.agentId}' not found.`
    );
  }

  const trace = await findOrCreateTrace({
    traceId: args.traceId,
    projectId: args.projectId,
    agentDbId: agent.id as number,
  });

  const gen = await db.Generation.create({
    publicId: args.publicId,
    projectId: args.projectId,
    agentId: agent.id,
    traceId: trace.id,
    initiatorGenerationId: initiatorGeneration?.id ?? null,
    startedByPrincipalType: args.startedByPrincipalType ?? null,
    startedByPrincipalId: args.startedByPrincipalId ?? null,
    status: 'in_progress',
    startedAt: new Date(),
    completedAt: null,
    lastActivityAt: null,
    stopReason: null,
    metadata: null,
  });

  const fullGeneration = await db.Generation.findByPk(gen.id, {
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.Trace, as: 'trace' },
      { model: db.Generation, as: 'initiatorGeneration' },
    ],
  });

  if (!fullGeneration) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Generation '${args.publicId}' not found.`
    );
  }

  return mapGeneration(fullGeneration);
};

export const updateGenerationRecord = async (args: {
  publicId: string;
  status?: string;
  completedAt?: Date | null;
  lastActivityAt?: Date | null;
  stopReason?: string | null;
  metadata?: Record<string, unknown> | null;
}) => {
  const gen = await db.Generation.findOne({
    where: { publicId: args.publicId },
  });
  if (!gen) return null;

  const updates: Record<string, unknown> = {};
  if (args.status !== undefined) updates.status = args.status;
  if (args.completedAt !== undefined) updates.completedAt = args.completedAt;
  if (args.lastActivityAt !== undefined)
    updates.lastActivityAt = args.lastActivityAt;
  if (args.stopReason !== undefined) updates.stopReason = args.stopReason;
  if (args.metadata !== undefined) updates.metadata = args.metadata;

  await gen.update(updates);

  const fullGeneration = await db.Generation.findByPk(gen.id, {
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.Trace, as: 'trace' },
      { model: db.Generation, as: 'initiatorGeneration' },
    ],
  });
  if (!fullGeneration) return null;

  return mapGeneration(fullGeneration);
};

export const listGenerations = async (args: {
  projectIds?: number[];
  agentId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0)
      return { data: [], total: 0, limit, offset };
    where.projectId = args.projectIds;
  }
  if (args.agentId !== undefined) {
    const agentWhere: { publicId: string; projectId?: number[] } = {
      publicId: args.agentId,
    };
    if (args.projectIds !== undefined) {
      agentWhere.projectId = args.projectIds;
    }

    const agent = await db.Agent.findOne({ where: agentWhere });
    if (!agent) return { data: [], total: 0, limit, offset };
    where.agentId = agent.id;
  }
  if (args.status !== undefined) where.status = args.status;

  const { count, rows } = await db.Generation.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.Trace, as: 'trace' },
      { model: db.Generation, as: 'initiatorGeneration' },
    ],
    order: [['startedAt', 'DESC']],
    limit,
    offset,
  });
  return { data: rows.map(mapGeneration), total: count, limit, offset };
};

export const getGeneration = async (args: {
  publicId: string;
  projectIds?: number[];
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { publicId: args.publicId };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const gen = await db.Generation.findOne({
    where,
    include: [
      { model: db.Agent, as: 'agent' },
      { model: db.Trace, as: 'trace' },
      { model: db.Generation, as: 'initiatorGeneration' },
    ],
  });
  if (!gen) return null;

  return mapGeneration(gen);
};
