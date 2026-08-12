import { db } from '../db';
import { DomainError } from '../errors';
import { resolveEndUserAttribution } from './generationAttribution';
import {
  buildCreateContentColumns,
  suppressContentWrites,
} from './generationContentSuppression';
import { mapGeneration, type PersistedGeneration } from './generationMapper';
import { findOrCreateTrace } from './generationTrace';
import { emptyPage, paginatedList } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';

// The row → wire mapper lives in its own module; re-exported so the many
// existing `from './generations'` imports of the type keep working.
export type { PersistedGeneration } from './generationMapper';

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
  // The workload behind the generation when it is not production traffic
  // (`eval`). Read back at metering time onto the usage event's own `source`
  // column (docs/prd-evaluations.md, Phase 2).
  source?: string | null;
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
    source: args.source ?? null,
  };
};

/**
 * Creates the Trace (if needed) and the Generation in one transaction.
 *
 * They must commit together, or a `Generation.create` failure orphans an
 * invisible Trace that still blocks `deleteAgent` (soat#815).
 */
const commitGenerationWithTrace = async (helperArgs: {
  args: GenerationAttribution & {
    publicId: string;
    projectId: number;
    traceId: string;
    startedByPrincipalType?: string | null;
    startedByPrincipalId?: string | null;
  };
  agentDbId: number;
  initiatorDbId: number | null;
  endUser: { actorId: number | null; sessionId: number | null };
  contentColumns: Record<string, unknown>;
}) => {
  const { args, agentDbId, initiatorDbId, endUser, contentColumns } =
    helperArgs;

  return db.sequelize.transaction(async (transaction) => {
    const trace = await findOrCreateTrace({
      traceId: args.traceId,
      projectId: args.projectId,
      agentDbId,
      transaction,
    });

    return db.Generation.create(
      {
        publicId: args.publicId,
        projectId: args.projectId,
        agentId: agentDbId,
        traceId: trace.id,
        initiatorGenerationId: initiatorDbId,
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
        ...contentColumns,
      },
      { transaction }
    );
  });
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

  // Zero-retention (#838): `metadata` is caller content, so it is refused at
  // creation rather than written and purged later. The row itself is still
  // created — the skeleton is what metering and audit read.
  const contentColumns = await buildCreateContentColumns({
    agentDbId: agent.id as number,
    metadata: args.metadata,
  });

  const gen = await commitGenerationWithTrace({
    args,
    agentDbId: agent.id as number,
    initiatorDbId: initiatorGeneration?.id ?? null,
    endUser,
    contentColumns,
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

  // Zero-retention (#838): drop the content columns from the write while the
  // lifecycle columns on the same update still land. Enforced here rather than
  // at the call sites because this is the only place those columns can be
  // written — a future caller inherits the guarantee instead of having to
  // remember it.
  await suppressContentWrites({
    agentDbId: gen.agentId,
    alreadyRedacted: gen.contentRedactedAt !== null,
    updates,
  });

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

type GenerationRow = InstanceType<(typeof db)['Generation']> & {
  project?: InstanceType<(typeof db)['Project']>;
  agent?: InstanceType<(typeof db)['Agent']> | null;
  trace?: InstanceType<(typeof db)['Trace']> | null;
  initiatorGeneration?: InstanceType<(typeof db)['Generation']> | null;
};

const generations = makeResourceAccessor<GenerationRow>({
  model: () => {
    return db.Generation;
  },
  includes: () => {
    return [
      { model: db.Project, as: 'project' },
      { model: db.Agent, as: 'agent' },
      { model: db.Trace, as: 'trace' },
      { model: db.Generation, as: 'initiatorGeneration' },
    ];
  },
  label: 'Generation',
});

export const listGenerations = async (args: {
  projectIds?: number[];
  agentId?: string;
  traceId?: string;
  initiatorGenerationId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};

  if (args.projectIds !== undefined) {
    if (args.projectIds.length === 0) return emptyPage(args);
    where.projectId = args.projectIds;
  }

  const resolved = await applyGenerationScopeFilters(where, {
    agentId: args.agentId,
    traceId: args.traceId,
    initiatorGenerationId: args.initiatorGenerationId,
    projectIds: args.projectIds,
  });
  if (!resolved) return emptyPage(args);

  if (args.status !== undefined) where.status = args.status;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Generation.findAndCountAll({
        where: Object.keys(where).length > 0 ? where : undefined,
        include: [
          { model: db.Project, as: 'project' },
          { model: db.Agent, as: 'agent' },
          { model: db.Trace, as: 'trace' },
          { model: db.Generation, as: 'initiatorGeneration' },
        ],
        order: [['startedAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: mapGeneration,
  });
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
  const gen = await generations.findByPublicId({
    id: args.publicId,
    projectIds: args.projectIds,
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
