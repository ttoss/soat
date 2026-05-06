import { db } from '../db';

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
  gen: InstanceType<(typeof db)['Generation']>
): PersistedGeneration => {
  return {
    id: gen.publicId,
    projectId: gen.projectId,
    agentId: gen.agentId,
    traceId: gen.traceId,
    initiatorGenerationId: gen.initiatorGenerationId,
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

export const createGenerationRecord = async (args: {
  publicId: string;
  projectId: number;
  agentId: string;
  agentDbId?: number | null;
  traceId: string;
  traceDbId?: number | null;
  initiatorGenerationId?: string | null;
  initiatorGenerationDbId?: number | null;
  startedByPrincipalType?: string | null;
  startedByPrincipalId?: string | null;
}) => {
  const gen = await db.Generation.create({
    publicId: args.publicId,
    projectId: args.projectId,
    agentId: args.agentId,
    agentDbId: args.agentDbId ?? null,
    traceId: args.traceId,
    traceDbId: args.traceDbId ?? null,
    initiatorGenerationId: args.initiatorGenerationId ?? null,
    initiatorGenerationDbId: args.initiatorGenerationDbId ?? null,
    startedByPrincipalType: args.startedByPrincipalType ?? null,
    startedByPrincipalId: args.startedByPrincipalId ?? null,
    status: 'in_progress',
    startedAt: new Date(),
    completedAt: null,
    lastActivityAt: null,
    stopReason: null,
    metadata: null,
  });
  return mapGeneration(gen);
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
  return mapGeneration(gen);
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
  if (args.agentId !== undefined) where.agentId = args.agentId;
  if (args.status !== undefined) where.status = args.status;

  const { count, rows } = await db.Generation.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
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

  const gen = await db.Generation.findOne({ where });
  if (!gen) return null;

  return mapGeneration(gen);
};
