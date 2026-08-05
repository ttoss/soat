import { db } from '../db';
import { DomainError } from '../errors';
import { resolveEndUserAttribution } from './generationAttribution';
import { findOrCreateTrace } from './generationTrace';

export type PersistedGeneration = {
  id: string;
  project_id: string;
  agent_id: string;
  trace_id: string;
  initiator_generation_id: string | null;
  started_by_principal_type: string | null;
  started_by_principal_id: string | null;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  last_activity_at: Date | null;
  stop_reason: string | null;
  error: Record<string, unknown> | null;
  action_id: string | null;
  trigger_id: string | null;
  orchestration_run_id: string | null;
  node_id: string | null;
  agent_version: number | null;
  routing: Record<string, unknown> | null;
  extraction: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  content_redacted_at: Date | null;
  content_redacted_by_principal_type: string | null;
  content_redacted_by_principal_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const mapGeneration = (
  gen: InstanceType<(typeof db)['Generation']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']>;
    trace?: InstanceType<(typeof db)['Trace']>;
    initiatorGeneration?: InstanceType<(typeof db)['Generation']> | null;
  }
): PersistedGeneration => {
  if (!gen.project || !gen.agent || !gen.trace) {
    throw new Error('Generation associations are required for serialization.');
  }

  return {
    id: gen.publicId,
    project_id: gen.project.publicId,
    agent_id: gen.agent.publicId,
    trace_id: gen.trace.publicId,
    initiator_generation_id: gen.initiatorGeneration?.publicId ?? null,
    started_by_principal_type: gen.startedByPrincipalType,
    started_by_principal_id: gen.startedByPrincipalId,
    status: gen.status,
    started_at: gen.startedAt,
    completed_at: gen.completedAt,
    last_activity_at: gen.lastActivityAt,
    stop_reason: gen.stopReason,
    error: gen.error,
    action_id: gen.actionId,
    trigger_id: gen.triggerId,
    orchestration_run_id: gen.orchestrationRunId,
    node_id: gen.nodeId,
    agent_version: gen.agentVersion,
    routing: gen.routing,
    extraction: gen.extraction,
    // Caller-owned bag, verbatim. `pendingState` has no entry here at all.
    metadata: gen.metadata,
    content_redacted_at: gen.contentRedactedAt,
    content_redacted_by_principal_type: gen.contentRedactedByPrincipalType,
    content_redacted_by_principal_id: gen.contentRedactedByPrincipalId,
    created_at: gen.createdAt,
    updated_at: gen.updatedAt,
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

type GenerationAttribution = {
  // Usage attribution, stored as typed columns. Server-supplied on every path
  // that has them; a caller cannot reach these.
  actionId?: string | null;
  triggerId?: string | null;
  orchestrationRunId?: string | null;
  nodeId?: string | null;
  agentVersion?: number | null;
};

// Normalizes the optional attribution args to their column values, so the
// create call below states each column once.
const attributionColumns = (args: GenerationAttribution) => {
  return {
    actionId: args.actionId ?? null,
    triggerId: args.triggerId ?? null,
    orchestrationRunId: args.orchestrationRunId ?? null,
    nodeId: args.nodeId ?? null,
    agentVersion: args.agentVersion ?? null,
  };
};

export const createGenerationRecord = async (
  args: GenerationAttribution & {
    publicId: string;
    projectId: number;
    agentId: string;
    traceId: string;
    initiatorGenerationId?: string | null;
    startedByPrincipalType?: string | null;
    startedByPrincipalId?: string | null;
    // Public id of the session this generation serves. The end-user actor is
    // derived from it (see resolveEndUserAttribution), never passed separately.
    sessionId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
) => {
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

  const endUser = await resolveEndUserAttribution({
    projectId: args.projectId,
    sessionId: args.sessionId,
  });

  // Trace + Generation must commit together, or a Generation.create failure
  // orphans an invisible Trace that still blocks deleteAgent (soat#815).
  const gen = await db.sequelize.transaction(async (transaction) => {
    const trace = await findOrCreateTrace({
      traceId: args.traceId,
      projectId: args.projectId,
      agentDbId: agent.id as number,
      transaction,
    });

    return db.Generation.create(
      {
        publicId: args.publicId,
        projectId: args.projectId,
        agentId: agent.id,
        traceId: trace.id,
        initiatorGenerationId: initiatorGeneration?.id ?? null,
        startedByPrincipalType: args.startedByPrincipalType ?? null,
        startedByPrincipalId: args.startedByPrincipalId ?? null,
        startedByActorId: endUser.actorId,
        sessionId: endUser.sessionId,
        status: 'in_progress',
        startedAt: new Date(),
        completedAt: null,
        lastActivityAt: null,
        stopReason: null,
        error: null,
        ...attributionColumns(args),
        metadata: args.metadata ?? null,
      },
      { transaction }
    );
  });

  const fullGeneration = await db.Generation.findByPk(gen.id, {
    include: [
      { model: db.Project, as: 'project' },
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

type UpdateGenerationRecordArgs = {
  publicId: string;
  status?: string;
  completedAt?: Date | null;
  lastActivityAt?: Date | null;
  stopReason?: string | null;
  error?: Record<string, unknown> | null;
  routing?: Record<string, unknown> | null;
  extraction?: Record<string, unknown> | null;
  pendingState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

// Every column an update may set, besides the selecting `publicId`. Listed once
// so "provided means write it, absent means leave it" is one rule, not one
// branch per field.
const UPDATABLE_GENERATION_FIELDS = [
  'status',
  'completedAt',
  'lastActivityAt',
  'stopReason',
  'error',
  'routing',
  'extraction',
  'pendingState',
  'metadata',
] as const satisfies ReadonlyArray<keyof UpdateGenerationRecordArgs>;

export const updateGenerationRecord = async (
  args: UpdateGenerationRecordArgs
) => {
  const gen = await db.Generation.findOne({
    where: { publicId: args.publicId },
  });
  if (!gen) return null;

  const updates: Record<string, unknown> = {};
  for (const field of UPDATABLE_GENERATION_FIELDS) {
    if (args[field] !== undefined) updates[field] = args[field];
  }

  await gen.update(updates);

  const fullGeneration = await db.Generation.findByPk(gen.id, {
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      { model: db.Trace, as: 'trace' },
      { model: db.Generation, as: 'initiatorGeneration' },
    ],
  });
  if (!fullGeneration) return null;

  return mapGeneration(fullGeneration);
};

// Resolves a project-scoped parent (agent/trace) publicId to its internal id
// for use as a generation list filter. Returns null when it does not exist in
// scope (caller yields an empty page).
const resolveScopedId = async (
  find: (where: {
    publicId: string;
    projectId?: number[];
  }) => Promise<{ id?: number } | null>,
  publicId: string,
  projectIds?: number[]
): Promise<number | null> => {
  const where: { publicId: string; projectId?: number[] } = { publicId };
  if (projectIds !== undefined) where.projectId = projectIds;
  const row = await find(where);
  return row?.id ?? null;
};

// Resolves agent/trace publicId filters into `where` (mutating it). Returns
// false when a referenced agent/trace does not exist in scope.
const applyGenerationScopeFilters = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>,
  args: {
    agentId?: string;
    traceId?: string;
    initiatorGenerationId?: string;
    projectIds?: number[];
  }
): Promise<boolean> => {
  if (args.agentId !== undefined) {
    const agentId = await resolveScopedId(
      (w) => {
        return db.Agent.findOne({ where: w });
      },
      args.agentId,
      args.projectIds
    );
    if (agentId === null) return false;
    where.agentId = agentId;
  }
  if (args.traceId !== undefined) {
    const traceId = await resolveScopedId(
      (w) => {
        return db.Trace.findOne({ where: w });
      },
      args.traceId,
      args.projectIds
    );
    if (traceId === null) return false;
    where.traceId = traceId;
  }
  if (args.initiatorGenerationId !== undefined) {
    const initiatorId = await resolveScopedId(
      (w) => {
        return db.Generation.findOne({ where: w });
      },
      args.initiatorGenerationId,
      args.projectIds
    );
    if (initiatorId === null) return false;
    where.initiatorGenerationId = initiatorId;
  }
  return true;
};

export const listGenerations = async (args: {
  projectIds?: number[];
  agentId?: string;
  traceId?: string;
  initiatorGenerationId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) => {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  const empty = { data: [], total: 0, limit, offset };

  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return empty;
    where.projectId = args.projectIds;
  }

  const resolved = await applyGenerationScopeFilters(where, {
    agentId: args.agentId,
    traceId: args.traceId,
    initiatorGenerationId: args.initiatorGenerationId,
    projectIds: args.projectIds,
  });
  if (!resolved) return empty;

  if (args.status !== undefined) where.status = args.status;

  const { count, rows } = await db.Generation.findAndCountAll({
    where: Object.keys(where).length > 0 ? where : undefined,
    include: [
      { model: db.Project, as: 'project' },
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

export const listGenerationsByTraceIds = async (args: {
  tracePublicIds: string[];
  projectIds?: number[];
}): Promise<PersistedGeneration[]> => {
  if (args.tracePublicIds.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traceWhere: Record<string, any> = { publicId: args.tracePublicIds };
  if (args.projectIds !== undefined) traceWhere.projectId = args.projectIds;

  const traces = await db.Trace.findAll({ where: traceWhere });
  const traceInternalIds = traces.map((t) => {
    return t.id as number;
  });
  if (traceInternalIds.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const genWhere: Record<string, any> = { traceId: traceInternalIds };
  if (args.projectIds !== undefined) genWhere.projectId = args.projectIds;

  const rows = await db.Generation.findAll({
    where: genWhere,
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      { model: db.Trace, as: 'trace' },
      { model: db.Generation, as: 'initiatorGeneration' },
    ],
    order: [['startedAt', 'ASC']],
  });

  return rows.map(mapGeneration);
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
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      { model: db.Trace, as: 'trace' },
      { model: db.Generation, as: 'initiatorGeneration' },
    ],
  });
  if (!gen) return null;

  return mapGeneration(gen);
};

// Attaches caller-supplied metadata to a generation (F-15). The provided keys
// are shallow-merged over the existing metadata so repeated patches accumulate.
// The bag holds only caller keys — server-owned state is in its own columns — so
// a merge here cannot touch attribution, and there is nothing to preserve
// against. Returns null when the generation does not exist within the caller's
// project scope.
export const updateGenerationMetadata = async (args: {
  publicId: string;
  projectIds?: number[];
  metadata: Record<string, unknown>;
}): Promise<PersistedGeneration | null> => {
  const existing = await getGeneration({
    publicId: args.publicId,
    projectIds: args.projectIds,
  });
  if (!existing) return null;

  const merged = { ...(existing.metadata ?? {}), ...args.metadata };

  return updateGenerationRecord({
    publicId: args.publicId,
    metadata: merged,
  });
};
