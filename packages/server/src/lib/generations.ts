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
  metadata: Record<string, unknown> | null;
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
    metadata: gen.metadata,
    created_at: gen.createdAt,
    updated_at: gen.updatedAt,
  };
};

// Generation.metadata also carries internal recovery state (`pendingState`:
// full message history, tool context, agent config) needed by
// agentGenerationRecovery.ts to resume paused generations after a restart.
// That must never reach API clients; only externally-meaningful keys (e.g.
// `extraction`, written by recordExtractionSummary) are safe to expose.
const INTERNAL_METADATA_KEYS = ['pendingState'];

// Keys the server owns inside the metadata bag. Callers may attach arbitrary
// key/value metadata for their own auditing (F-15), but must not clobber these:
// `pendingState` is internal recovery state; `action_id`/`trigger_id`/`orchestration_run_id`/
// `node_id` are the wire names (see generations.yaml) for the usage-attribution
// keys read back by usageRecording.ts (stored internally as `actionId`/
// `triggerId`/`orchestrationRunId`/`nodeId`); `extraction` is the memory-extraction
// summary written on completion; and `routing` is the model route's own record of
// which target served the generation. Writes that include any of these are rejected
// so caller metadata can never corrupt system bookkeeping or usage rollups.
// Reserved-key validation runs against the raw wire request body (there is no
// recursive case-transform middleware anymore), so both the wire (snake_case)
// names AND the internal camelCase storage names must be blocked here —
// updateGenerationMetadata shallow-merges caller metadata directly over the
// stored object, so a caller sending the camelCase spelling verbatim would
// otherwise overwrite real attribution with a forged one.
export const RESERVED_GENERATION_METADATA_KEYS = [
  'pendingState',
  'action_id',
  'actionId',
  'trigger_id',
  'triggerId',
  'orchestration_run_id',
  'orchestrationRunId',
  'node_id',
  'nodeId',
  'extraction',
  // Written by the served-version resolver: the agent config version this
  // generation ran against. Forging it would misattribute a canary's behavior
  // to the stable version (or the reverse) in every downstream comparison.
  'agent_version',
  'agentVersion',
  // Written by the model-route executor: which target actually served the
  // generation, and every attempt it burned getting there.
  'routing',
];

// Validates caller-supplied generation metadata. Shared by the create-agent-
// generation route and the update-generation route so both enforce the same
// rule. Returns an error message string, or null when the metadata is valid.
export const validateGenerationMetadata = (
  metadata: unknown
): string | null => {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return 'metadata must be a JSON object';
  }

  const reserved = Object.keys(metadata).filter((key) => {
    return RESERVED_GENERATION_METADATA_KEYS.includes(key);
  });

  if (reserved.length > 0) {
    return `metadata contains reserved keys that cannot be set by callers: ${reserved.join(', ')}`;
  }

  return null;
};

export const toPublicGenerationMetadata = (
  metadata: Record<string, unknown> | null
): Record<string, unknown> | null => {
  if (!metadata) return null;

  const publicMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => {
      return !INTERNAL_METADATA_KEYS.includes(key);
    })
  );

  return Object.keys(publicMetadata).length > 0 ? publicMetadata : null;
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

export const createGenerationRecord = async (args: {
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

export const updateGenerationRecord = async (args: {
  publicId: string;
  status?: string;
  completedAt?: Date | null;
  lastActivityAt?: Date | null;
  stopReason?: string | null;
  error?: Record<string, unknown> | null;
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
  if (args.error !== undefined) updates.error = args.error;
  if (args.metadata !== undefined) updates.metadata = args.metadata;

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
// are shallow-merged over the existing metadata, so system-owned keys
// (`pendingState`, attribution, `extraction`) are preserved and repeated
// patches accumulate. Callers cannot set reserved keys — enforce
// validateGenerationMetadata before calling. Returns null when the generation
// does not exist within the caller's project scope.
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
