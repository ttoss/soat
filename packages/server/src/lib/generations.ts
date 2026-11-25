import { db } from '../db';
import { DomainError } from '../errors';
import type { Transaction } from './dbTransaction';
import {
  attributionColumns,
  conversationColumns,
  findInitiatorGeneration,
  type GenerationAttribution,
  type GenerationConversation,
  resolveEndUserAttribution,
} from './generationAttribution';
import { findChainIdByRoot, recordChainGrowth } from './generationChains';
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
import {
  appendGenerationStarted,
  type ParentToolCall,
} from './generationProgress';
import {
  NO_PROVENANCE,
  provenanceColumns,
  type ProvenanceCounts,
} from './generationProvenance';
import {
  newGenerationLease,
  startGenerationSegment,
} from './generationSegment';
import { findOrCreateTrace, findTraceDbId } from './generationTrace';
import { readInputModalities } from './inputModalities';
import type { GenerationClock } from './instructionTemplates';
import type { KnowledgeRetrieval } from './knowledgeRetrievalRecord';
import { emptyPage, paginatedList } from './pagination';
import { type StartedWork, startedWorkColumns } from './principals';
import { projectScopeWhere } from './projectScope';
import { makeResourceAccessor } from './resourceAccessor';
import { agentReferences } from './resourceReferences';
import { rollUpUsageTotals } from './usageAggregate';
import { withGenerationEmbeddingUsage } from './usageEmbeddingRecording';

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
 * Creates the Trace (if needed) and the Generation in one transaction.
 *
 * They must commit together, or a `Generation.create` failure orphans an
 * invisible Trace that still blocks `deleteAgent`.
 */
const traceOfNewGeneration = async (helperArgs: {
  args: {
    traceId: string;
    parentTraceId?: string | null;
    rootTraceId?: string | null;
    projectId: number;
  };
  agentDbId: number;
  transaction: Transaction;
}) => {
  const { args, agentDbId, transaction } = helperArgs;
  const [parentTraceDbId, rootTraceDbId] = await Promise.all([
    findTraceDbId({ traceId: args.parentTraceId, transaction }),
    findTraceDbId({ traceId: args.rootTraceId, transaction }),
  ]);
  return findOrCreateTrace({
    traceId: args.traceId,
    projectId: args.projectId,
    agentDbId,
    parentTraceDbId,
    rootTraceDbId,
    transaction,
  });
};

const clockColumns = (clock: GenerationClock | null) => {
  return {
    startedAt: clock?.now ?? new Date(),
    timezone: clock?.timezone ?? null,
  };
};

const commitGenerationWithTrace = async (helperArgs: {
  args: NewGenerationRecord & { inputModalities: string[] };
  agentDbId: number;
  initiatorDbId: number | null;
  conversation: Awaited<ReturnType<typeof conversationColumns>>;
  chainId: string | null;
  endUser: { actorId: number | null; sessionId: number | null };
  contentColumns: Record<string, unknown>;
}) => {
  const {
    args,
    agentDbId,
    initiatorDbId,
    conversation,
    chainId,
    endUser,
    contentColumns,
  } = helperArgs;
  const lease = newGenerationLease();

  const gen = await db.sequelize.transaction(async (transaction) => {
    const trace = await traceOfNewGeneration({ args, agentDbId, transaction });

    const created = await db.Generation.create(
      {
        publicId: args.publicId,
        projectId: args.projectId,
        agentId: agentDbId,
        traceId: trace.id,
        initiatorGenerationId: initiatorDbId,
        rootGenerationId: args.rootGenerationId ?? null,
        ...conversation,
        chainId,
        ...(await startedWorkColumns({
          authority: args.authority,
          projectId: args.projectId,
          actsAsAgent: args.actsAsAgent,
        })),
        startedByActorId: endUser.actorId,
        sessionId: endUser.sessionId,
        // Created running is a claim: the creating process holds the lease.
        status: 'running',
        ...lease,
        ...clockColumns(args.clock),
        // Zero, not null: its steps are step objects, never the legacy object.
        stepCount: 0,
        // Not a content column: three integers describing the request, which a
        // purge and zero-retention both leave standing.
        toolSurface: args.toolSurface ?? null,
        // Part types, not content — see the column.
        inputModalities: args.inputModalities,
        // Pointers, not text — see the column.
        retrieval: args.retrieval ?? null,
        citations: args.citesSources ? [] : null,
        // Counts, not content — see the columns.
        ...provenanceColumns(args.provenance ?? NO_PROVENANCE),
        idempotencyKey: args.idempotency?.key ?? null,
        idempotencyDigest: args.idempotency?.digest ?? null,
        ...attributionColumns(args),
        ...contentColumns,
      },
      { transaction }
    );
    await appendGenerationStarted({
      generationDbId: created.id as number,
      generationId: args.publicId,
      parentCall: args.parentCall,
      transaction,
    });
    return created;
  });
  return { gen, lease };
};

type NewGenerationRecord = GenerationAttribution &
  StartedWork & {
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
    // The conversation this generation serves, when it serves one: the edge
    // the memory assertions walk up from a generation.
    conversation?: GenerationConversation;
    // Public id of the session this generation serves. The end-user actor is
    // derived from it (see resolveGenerationEndUser).
    sessionId?: string | null;
    // Public id of an actor named with no session; ignored beside a session.
    actorId?: string | null;
    metadata?: Record<string, unknown> | null;
    // The turn's resolved input messages, recorded so the generation can later
    // be promoted into an eval dataset item. Content, so zero-retention refuses
    // it exactly as it refuses `metadata`.
    inputMessages?: unknown[] | null;
    // Measured, never caller-supplied. Not content — see the column.
    toolSurface?: Record<string, unknown> | null;
    retrieval?: KnowledgeRetrieval;
    // Whether the turn cites: `citations` starts empty, else null.
    citesSources?: boolean;
    // A unique violation on it is the caller's retry losing the race.
    idempotency?: GenerationIdempotency;
    // What the turn's context already holds when it starts: its chain's
    // counts, its input and its knowledge injection.
    provenance?: ProvenanceCounts;
    parentCall?: ParentToolCall | null;
    // The clock the turn's instructions rendered from: its instant is the
    // record's `startedAt`. Null for a turn refused before its context.
    clock: GenerationClock | null;
  };

const insertGenerationRecord = async (args: NewGenerationRecord) => {
  const [agent, initiatorGeneration] = await Promise.all([
    // The agent that is running: the project's own, or one shared with it.
    agentReferences.find({
      id: args.agentId,
      projectId: args.projectId,
      reach: 'shares',
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
    actorId: args.actorId,
  });

  // Zero-retention: `metadata` and `inputMessages` are content, so they
  // are refused at creation rather than written and purged later. The row itself
  // is still created — the skeleton is what metering and audit read.
  const contentColumns = await buildCreateContentColumns({
    agentDbId: agent.id as number,
    projectDbId: args.projectId,
    metadata: args.metadata,
    inputMessages: args.inputMessages,
  });

  // Denormalized so a generation names its chain without a join. The chain row
  // is created by `resolveChainContext` before this runs, so the lookup finds
  // it; a null here just means this turn is not a continuation.
  const chainId = args.rootGenerationId
    ? await findChainIdByRoot(args.rootGenerationId)
    : null;

  const { gen, lease } = await commitGenerationWithTrace({
    args: {
      ...args,
      inputModalities: readInputModalities(args.inputMessages),
    },
    agentDbId: agent.id as number,
    initiatorDbId: initiatorGeneration?.id ?? null,
    conversation: await conversationColumns(args.conversation),
    chainId,
    endUser,
    contentColumns,
  });
  startGenerationSegment({ generationId: args.publicId, lease });

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

export const createGenerationRecord = (
  args: Parameters<typeof insertGenerationRecord>[0]
) => {
  return withGenerationEmbeddingUsage({
    record: args,
    create: insertGenerationRecord,
  });
};

// No status column: a status is written only by `settleGeneration`.
type UpdateGenerationRecordArgs = {
  publicId: string;
  routing?: Record<string, unknown> | null;
  extraction?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

// Every column an update may set, besides the selecting `publicId`. Listed once
// so "provided means write it, absent means leave it" is one rule, not one
// branch per field.
const UPDATABLE_GENERATION_FIELDS = [
  'routing',
  'extraction',
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

  // Drops the content columns while the other columns on the same update still
  // land; `settleGeneration` applies the same rule to its write.
  await suppressContentWrites({
    agentDbId: gen.agentId,
    projectDbId: gen.projectId,
    alreadyRedacted: gen.contentRedactedAt !== null,
    updates,
  });

  await gen.update(updates);

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

export const GENERATION_STATUSES = [
  'running',
  'requires_action',
  'completed',
  'failed',
] as const;

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
  statuses?: readonly (typeof GENERATION_STATUSES)[number][];
  limit?: number;
  cursor?: string;
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};

  if (args.projectIds?.length === 0) return emptyPage(args);
  Object.assign(where, projectScopeWhere({ projectIds: args.projectIds }));

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

  if (args.statuses?.length) where.status = args.statuses;

  // Every argument but the page itself narrows the list.
  const { limit: _limit, cursor: _cursor, ...filters } = args;
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters,
    where: Object.keys(where).length > 0 ? where : undefined,
    order: [['startedAt', 'DESC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.Generation.findAll({
        where: pageWhere,
        include: generationIncludes(),
        order,
        limit,
      });
    },
    map: mapGeneration,
  });
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
  const usage = await rollUpUsageTotals({
    projectId: gen.projectId,
    from: null,
    to: null,
    generationId: gen.id,
  });

  return mapGenerationWithUsage(gen, usage);
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
