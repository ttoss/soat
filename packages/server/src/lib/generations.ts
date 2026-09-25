import { db } from '../db';
import { DomainError } from '../errors';
import {
  attributionColumns,
  type GenerationAttribution,
  resolveEndUserAttribution,
} from './generationAttribution';
import {
  findChainIdByRoot,
  noteChainMemberSettled,
  recordChainGrowth,
} from './generationChains';
import {
  buildCreateContentColumns,
  suppressContentWrites,
} from './generationContentSuppression';
import type { GenerationIdempotency } from './generationIdempotency';
import { applyGenerationScopeFilters } from './generationListFilters';
import {
  mapGeneration,
  mapGenerationWithUsage,
  type PersistedGeneration,
} from './generationMapper';
import { findOrCreateTrace, findTraceDbId } from './generationTrace';
import { listGenerationMemoryAssertions } from './memoryAssertions';
import { emptyPage, paginatedList } from './pagination';
import { makeResourceAccessor } from './resourceAccessor';
import { rollUpUsageTotals } from './usageAggregate';

// The row → wire mapper lives in its own module; re-exported so the many
// existing `from './generations'` imports of the type keep working.
export type { PersistedGeneration } from './generationMapper';

/**
 * Every association `mapGeneration` reads, in one place: the create, update,
 * get, list and by-trace reads all serialize through the same mapper, and a
 * per-read include list is how one of them silently starts reporting `null` for
 * a field the others fill.
 */
const generationIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.Agent, as: 'agent' },
    { model: db.Trace, as: 'trace' },
    { model: db.Generation, as: 'initiatorGeneration' },
    { model: db.Session, as: 'session' },
    { model: db.Actor, as: 'startedByActor' },
    { model: db.Conversation, as: 'conversation' },
  ];
};

/**
 * The conversation a turn served, by public id. Resolved here rather than
 * threaded as an internal id: every other caller of `createGenerationRecord`
 * speaks in public ids, and a conversation that no longer exists simply leaves
 * the column null.
 */
const findConversationDbId = async (
  conversationId?: string | null
): Promise<number | null> => {
  if (!conversationId) return null;
  const conversation = await db.Conversation.findOne({
    where: { publicId: conversationId },
    attributes: ['id'],
  });
  return (conversation?.id as number | undefined) ?? null;
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

/**
 * Creates the Trace (if needed) and the Generation in one transaction.
 *
 * They must commit together, or a `Generation.create` failure orphans an
 * invisible Trace that still blocks `deleteAgent`.
 */
const commitGenerationWithTrace = async (helperArgs: {
  args: GenerationAttribution & {
    publicId: string;
    projectId: number;
    traceId: string;
    parentTraceId?: string | null;
    rootTraceId?: string | null;
    rootGenerationId?: string | null;
    startedByPrincipalType?: string | null;
    startedByPrincipalId?: string | null;
    toolSurface?: Record<string, unknown> | null;
    idempotency?: GenerationIdempotency;
  };
  agentDbId: number;
  initiatorDbId: number | null;
  conversationDbId: number | null;
  chainId: string | null;
  endUser: { actorId: number | null; sessionId: number | null };
  contentColumns: Record<string, unknown>;
}) => {
  const {
    args,
    agentDbId,
    initiatorDbId,
    conversationDbId,
    chainId,
    endUser,
    contentColumns,
  } = helperArgs;

  return db.sequelize.transaction(async (transaction) => {
    const [parentTraceDbId, rootTraceDbId] = await Promise.all([
      findTraceDbId({ traceId: args.parentTraceId, transaction }),
      findTraceDbId({ traceId: args.rootTraceId, transaction }),
    ]);

    const trace = await findOrCreateTrace({
      traceId: args.traceId,
      projectId: args.projectId,
      agentDbId,
      parentTraceDbId,
      rootTraceDbId,
      transaction,
    });

    return db.Generation.create(
      {
        publicId: args.publicId,
        projectId: args.projectId,
        agentId: agentDbId,
        traceId: trace.id,
        initiatorGenerationId: initiatorDbId,
        rootGenerationId: args.rootGenerationId ?? null,
        conversationId: conversationDbId,
        chainId,
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
        // Not a content column: three integers describing the request, which a
        // purge and zero-retention both leave standing.
        toolSurface: args.toolSurface ?? null,
        idempotencyKey: args.idempotency?.key ?? null,
        idempotencyDigest: args.idempotency?.digest ?? null,
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
    parentTraceId?: string | null;
    rootTraceId?: string | null;
    // The chain this generation belongs to, resolved by `generationChain.ts`,
    // which is the only writer of the column.
    rootGenerationId?: string | null;
    initiatorGenerationId?: string | null;
    startedByPrincipalType?: string | null;
    startedByPrincipalId?: string | null;
    // Public id of the conversation this generation serves, when it serves one.
    // The edge the memory assertions walk up from a generation.
    conversationId?: string | null;
    // Public id of the session this generation serves. The end-user actor is
    // derived from it (see resolveEndUserAttribution), never passed separately.
    sessionId?: string | null;
    metadata?: Record<string, unknown> | null;
    // The turn's resolved input messages, recorded so the generation can later
    // be promoted into an eval dataset item. Content, so zero-retention refuses
    // it exactly as it refuses `metadata`.
    inputMessages?: unknown[] | null;
    // Measured, never caller-supplied. Not content — see the column.
    toolSurface?: Record<string, unknown> | null;
    // A unique violation on it is the caller's retry losing the race.
    idempotency?: GenerationIdempotency;
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

  // Zero-retention: `metadata` and `inputMessages` are content, so they
  // are refused at creation rather than written and purged later. The row itself
  // is still created — the skeleton is what metering and audit read.
  const contentColumns = await buildCreateContentColumns({
    agentDbId: agent.id as number,
    metadata: args.metadata,
    inputMessages: args.inputMessages,
  });

  // Denormalized so a generation names its chain without a join. The chain row
  // is created by `resolveChainContext` before this runs, so the lookup finds
  // it; a null here just means this turn is not a continuation.
  const chainId = args.rootGenerationId
    ? await findChainIdByRoot(args.rootGenerationId)
    : null;

  const gen = await commitGenerationWithTrace({
    args,
    agentDbId: agent.id as number,
    initiatorDbId: initiatorGeneration?.id ?? null,
    conversationDbId: await findConversationDbId(args.conversationId),
    chainId,
    endUser,
    contentColumns,
  });

  // After the row commits, so the re-derived count includes this hop. Awaited
  // (it never throws) so a caller reading the chain right after creating a
  // generation sees the population it just joined.
  if (args.rootGenerationId) {
    await recordChainGrowth({ rootGenerationId: args.rootGenerationId });
  }

  const fullGeneration = await db.Generation.findByPk(gen.id, {
    include: generationIncludes(),
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

  // Drops the content columns while the lifecycle columns on the same update
  // still land. Enforced here, the only place those columns can be
  // written, so a future caller inherits the guarantee.
  await suppressContentWrites({
    agentDbId: gen.agentId,
    alreadyRedacted: gen.contentRedactedAt !== null,
    updates,
  });

  await gen.update(updates);

  // A member settling is the only signal a chain has that it may be finished.
  noteChainMemberSettled({
    rootGenerationId: gen.rootGenerationId,
    status: gen.status,
  });

  const fullGeneration = await db.Generation.findByPk(gen.id, {
    include: generationIncludes(),
  });
  if (!fullGeneration) return null;

  return mapGeneration(fullGeneration);
};

type GenerationRow = InstanceType<(typeof db)['Generation']> & {
  project?: InstanceType<(typeof db)['Project']>;
  agent?: InstanceType<(typeof db)['Agent']> | null;
  trace?: InstanceType<(typeof db)['Trace']> | null;
  initiatorGeneration?: InstanceType<(typeof db)['Generation']> | null;
  session?: InstanceType<(typeof db)['Session']> | null;
  startedByActor?: InstanceType<(typeof db)['Actor']> | null;
};

export const generations = makeResourceAccessor<GenerationRow>({
  model: () => {
    return db.Generation;
  },
  includes: generationIncludes,
  label: 'Generation',
});

/**
 * The trace a generation was recorded on, by public id.
 *
 * The transcript route projects both, so it authorizes against both; this is
 * the edge it walks to name the trace's SRN. Deliberately not the generation's
 * own `findScope`, which answers a project rather than the second resource.
 *
 * A `get*`, not a `find*`: every generation row carries a trace, so the only
 * way this misses is a generation that is not there — and the caller has no
 * second thing to do about that. Answering `null` instead would push a branch
 * onto the route that nothing can reach.
 */
export const getGenerationTraceId = async (args: {
  id: string;
}): Promise<string> => {
  const row = (await db.Generation.findOne({
    where: { publicId: args.id },
    include: [{ model: db.Trace, as: 'trace', attributes: ['publicId'] }],
  })) as { trace?: { publicId?: unknown } | null } | null;

  const publicId = row?.trace?.publicId;
  if (typeof publicId !== 'string') throw generations.notFound(args.id);
  return publicId;
};

export const listGenerations = async (args: {
  projectIds?: number[];
  agentId?: string;
  traceId?: string;
  sessionId?: string;
  actorId?: string;
  initiatorGenerationId?: string;
  chainId?: string;
  orchestrationRunId?: string;
  nodeId?: string;
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
    sessionId: args.sessionId,
    actorId: args.actorId,
    initiatorGenerationId: args.initiatorGenerationId,
    projectIds: args.projectIds,
  });
  if (!resolved) return emptyPage(args);

  // Plain equality: these columns store public ids verbatim, not an internal
  // FK, so there is nothing to resolve and an unknown value matches no row.
  if (args.chainId !== undefined) where.chainId = args.chainId;
  if (args.orchestrationRunId !== undefined) {
    where.orchestrationRunId = args.orchestrationRunId;
  }
  if (args.nodeId !== undefined) where.nodeId = args.nodeId;

  if (args.status !== undefined) where.status = args.status;

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    order: [['startedAt', 'DESC']],
    query: ({ limit, offset, order }) => {
      return db.Generation.findAndCountAll({
        where: Object.keys(where).length > 0 ? where : undefined,
        include: generationIncludes(),
        distinct: true,
        order,
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
    include: generationIncludes(),
    order: [['startedAt', 'ASC']],
  });

  return rows.map(mapGeneration);
};

export const getGeneration = async (args: {
  publicId: string;
  projectIds?: number[];
  includeUsage?: boolean;
}) => {
  const gen = await generations.findByPublicId({
    id: args.publicId,
    projectIds: args.projectIds,
  });
  if (!gen) return null;

  if (!args.includeUsage) return mapGeneration(gen);

  // The turn's own events: one per segment, so a turn that paused for client
  // tools has several. Sub-agent turns meter against their own generation, so
  // summing is also what keeps a delegating turn honest.
  const [usage, memoryAssertions] = await Promise.all([
    rollUpUsageTotals({
      projectId: gen.projectId,
      from: null,
      to: null,
      generationId: gen.id,
    }),
    // Alongside the per-rule `extraction` counts, so the summary and the rows
    // it summarizes can be reconciled. It also covers the writes the summary
    // never saw: a `write_memory` call mid-turn is not a rule firing.
    listGenerationMemoryAssertions({ generationDbId: gen.id as number }),
  ]);

  return mapGenerationWithUsage(gen, usage, memoryAssertions);
};

// Shallow-merged so repeated patches accumulate. The bag holds only caller
// keys — server-owned state lives in its own columns — so a merge here cannot
// touch attribution.
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
