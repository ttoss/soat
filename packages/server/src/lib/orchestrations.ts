/* eslint-disable max-lines */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type {
  mapOrchestrationEdge,
  mapOrchestrationNode,
} from './orchestrationGraphWire';
import { mapOrchestrationGraph } from './orchestrationGraphWire';
import {
  assertOrchestrationUpdateValid,
  assertOrchestrationValid,
} from './orchestrationValidation';
import {
  buildOrchestrationConfigSnapshot,
  orchestrationVersionStore,
} from './orchestrationVersionSnapshot';
import {
  paginatedList,
  type PaginatedResult,
  resolvePagination,
} from './pagination';
import { getRunUsageTotals, type UsageTotals } from './usageReceipt';

const log = createDebug('soat:orchestrations');

// ── Types ─────────────────────────────────────────────────────────────────

export type OrchestratorNodeType =
  | 'agent'
  | 'tool'
  | 'transform'
  | 'knowledge'
  | 'memory_write'
  | 'condition'
  | 'human'
  | 'approval'
  | 'loop'
  | 'poll'
  | 'delay'
  | 'webhook'
  | 'emit_event'
  | 'sub_orchestration';

export type RetryBackoffStrategy = 'fixed' | 'exponential';

/**
 * Per-node retry policy. When a node throws a *retriable* error and attempts
 * remain, the run parks as `sleeping` and re-executes the node after the backoff
 * delay. Absent (or `maxAttempts <= 1`) preserves fail-fast behaviour.
 */
export type NodeRetryPolicy = {
  maxAttempts?: number;
  backoff?: {
    strategy?: RetryBackoffStrategy;
    delayMs?: number;
    maxDelayMs?: number;
  };
};

export type OrchestrationNode = {
  id: string;
  type: OrchestratorNodeType;
  // agent node
  agentId?: string;
  // tool node
  toolId?: string;
  operationId?: string;
  // transform/condition node — JSON Logic rule (https://jsonlogic.com)
  expression?: unknown;
  // knowledge node fields are provided via input_mapping
  // human node
  prompt?: string;
  options?: string[];
  // approval node — proposes a guarded tool call (`toolId`) and parks the run as
  // `awaiting_input` until a human approves/rejects (or it expires). `arguments`
  // is an input-mapping-style object resolved against run state at emit time;
  // `reasoning`/`evidence`/`predictedImpact` are JSON Logic resolved into the
  // item's evidence; `expiresIn` is seconds until expiry; `instructions` is
  // optional approver guidance.
  arguments?: Record<string, unknown>;
  expiresIn?: number;
  instructions?: string;
  reasoning?: unknown;
  evidence?: unknown;
  predictedImpact?: unknown;
  // memory_write node
  memoryId?: string;
  // loop node — runs the orchestration named by `orchestrationId` (shared with
  // the sub_orchestration node) once per item in `collection`.
  collection?: string;
  itemVariable?: string;
  parallelism?: number;
  // poll node — reuses toolId/operationId/inputMapping (the tool to call) and
  // maxIterations (attempt cap). exitCondition is the JSON Logic stop condition
  // (truthy ⇒ stop), interval is the wait between attempts, and failOnTimeout
  // fails the run when the attempt cap is reached without the condition holding.
  exitCondition?: unknown;
  interval?: string;
  failOnTimeout?: boolean;
  // delay node / poll node — duration string: a friendly suffix form
  // (`5s`, `30s`, `5m`, `2h`, `500ms`) or ISO 8601 (e.g. PT5S).
  duration?: string;
  // webhook node — parks the run awaiting an inbound callback (`mode: receive`).
  // Outbound notification is not a webhook node concern: emit an `emit_event`
  // node instead and let a Webhook subscription deliver it (see eventType).
  mode?: 'receive';
  // emit_event node — emits an internal domain event of type `eventType`
  // carrying the input-mapped payload as the event `data`. Any Webhook
  // subscribed to that event type (in the run's project) then delivers it —
  // signed, retried, and tracked by the Webhooks module — so a graph never
  // holds a URL or secret of its own. Reactive, fire-and-forget: the run does
  // not block on or fail from delivery outcome.
  eventType?: string;
  // sub_orchestration node
  orchestrationId?: string;
  // Shared: max iterations for cycles
  maxIterations?: number;
  // Shared mappings — values are JSON Logic (literal or expression).
  // inputMapping: { <inputKey>: <expr over state> }.
  // stateMapping: { <state.path>: <expr over { output: artifact, state }> } —
  // keys are write destinations, mirroring input_mapping's read-source shape.
  inputMapping?: Record<string, unknown>;
  stateMapping?: Record<string, unknown>;
  outputSchema?: object;
  // Retry-on-failure policy for this node (see NodeRetryPolicy).
  retry?: NodeRetryPolicy;
};

export type OrchestrationEdge = {
  from: string;
  to: string;
  condition?: string;
  activationGroup?: string;
  activationCondition?: 'all' | 'any';
};

/**
 * The authorship a write attaches to the version it archives. Optional
 * throughout: a write with no request user behind it (a scheduler-driven apply,
 * an internal repair) archives a version with a null author rather than none.
 */
export type OrchestrationVersionAuthorship = {
  createdByUserId?: number | null;
  versionLabel?: string | null;
};

export type MappedOrchestration = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  version: number;
  nodes: ReturnType<typeof mapOrchestrationNode>[];
  edges: ReturnType<typeof mapOrchestrationEdge>[];
  state_schema: object | null;
  input_schema: object | null;
  created_at: Date;
  updated_at: Date;
};

export type MappedNodeExecution = {
  node_id: string;
  node_type: string | null;
  attempt: number;
  status: 'running' | 'completed' | 'failed' | 'requires_action' | 'skipped';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: object | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
};

export type MappedOrchestrationRun = {
  id: string;
  orchestration_id: string;
  // The orchestration version this run executes, fixed when the run started.
  // Null for runs created before pinning existed (#872), which execute the live
  // graph — the only thing there is to fall back to.
  orchestration_version: number | null;
  project_id: string;
  status:
    | 'queued'
    | 'running'
    | 'sleeping'
    | 'awaiting_input'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'expired';
  state: Record<string, unknown>;
  active_nodes: string[];
  artifacts: Record<string, unknown>;
  error: object | null;
  required_action: object | null;
  trace_id: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  node_executions: MappedNodeExecution[];
  // Usage roll-up (tokens + cost_usd) summed across every metered generation the
  // run produced. Populated on the single-run read; omitted from list responses.
  // `UsageTotals` is the internal camelCase shape; this is its wire projection.
  usage?: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cached_tokens: number;
    total_reasoning_tokens: number;
    total_cost_usd: number | null;
  };
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

// ── Map helpers ───────────────────────────────────────────────────────────

const mapOrchestration = (
  orch: InstanceType<typeof db.Orchestration> & {
    project: InstanceType<typeof db.Project>;
  }
): MappedOrchestration => {
  return {
    id: orch.publicId,
    project_id: orch.project.publicId,
    name: orch.name,
    description: orch.description,
    version: orch.version,
    ...mapOrchestrationGraph({
      nodes: orch.nodes as OrchestrationNode[],
      edges: orch.edges as OrchestrationEdge[],
    }),
    state_schema: orch.stateSchema,
    input_schema: orch.inputSchema,
    created_at: orch.createdAt,
    updated_at: orch.updatedAt,
  };
};

export const mapNodeExecution = (
  exec: InstanceType<typeof db.OrchestrationNodeExecution>
): MappedNodeExecution => {
  return {
    node_id: exec.nodeId,
    node_type: exec.nodeType,
    attempt: exec.attempt,
    status: exec.status,
    input: exec.input as Record<string, unknown> | null,
    output: exec.output as Record<string, unknown> | null,
    error: exec.error,
    started_at: exec.startedAt,
    completed_at: exec.completedAt,
    created_at: exec.createdAt,
  };
};

/**
 * The wire projection of a `RequiredAction`, used for both the freshly-built
 * action and the one persisted on the run row (stored camelCase, so it is read
 * loosely here). `context` is the input-mapped payload the graph author shaped
 * and `approval_spec` is the frozen tool proposal — both copied as values, so
 * their inner keys stay exactly as authored.
 */
export const mapRequiredAction = (raw: unknown): object | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;

  const action = raw as Record<string, unknown>;

  /** Reads a field under either spelling — persisted rows carry the camelCase one. */
  const field = (camel: string, snake: string): unknown => {
    return action[camel] ?? action[snake];
  };

  const optional = Object.entries({
    options: action.options,
    approval_spec: field('approvalSpec', 'approval_spec'),
    approval_id: field('approvalId', 'approval_id'),
    expires_at: field('expiresAt', 'expires_at'),
  }).filter(([, value]) => {
    return value !== undefined && value !== null;
  });

  return {
    type: action.type,
    node_id: field('nodeId', 'node_id'),
    prompt: action.prompt,
    context: action.context,
    ...Object.fromEntries(optional),
  };
};

export const mapOrchestrationRun = (
  run: InstanceType<typeof db.OrchestrationRun> & {
    orchestration: InstanceType<typeof db.Orchestration>;
    project: InstanceType<typeof db.Project>;
    nodeExecutions?: InstanceType<typeof db.OrchestrationNodeExecution>[];
  },
  usage?: UsageTotals
): MappedOrchestrationRun => {
  return {
    id: run.publicId,
    orchestration_id: run.orchestration.publicId,
    orchestration_version: run.orchestrationVersion,
    project_id: run.project.publicId,
    status: run.status,
    state: run.state as Record<string, unknown>,
    active_nodes: run.activeNodes as string[],
    artifacts: run.artifacts as Record<string, unknown>,
    error: run.error,
    required_action: mapRequiredAction(run.requiredAction),
    trace_id: run.traceId,
    input: run.input as Record<string, unknown> | null,
    output: run.output as Record<string, unknown> | null,
    node_executions: (run.nodeExecutions ?? []).map(mapNodeExecution),
    ...(usage
      ? {
          usage: {
            total_input_tokens: usage.totalInputTokens,
            total_output_tokens: usage.totalOutputTokens,
            total_cached_tokens: usage.totalCachedTokens,
            total_reasoning_tokens: usage.totalReasoningTokens,
            total_cost_usd: usage.totalCostUsd,
          },
        }
      : {}),
    started_at: run.startedAt,
    completed_at: run.completedAt,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
};

/**
 * Sequelize include for the per-node execution records of a run, ordered
 * oldest-first. Returned as a function because `db` is populated at runtime.
 */
export const nodeExecutionsInclude = (): object => {
  return {
    model: db.OrchestrationNodeExecution,
    as: 'nodeExecutions',
    separate: true,
    order: [['createdAt', 'ASC']],
  };
};

// ── CRUD: Orchestrations ──────────────────────────────────────────────────

export const createOrchestration = async (
  args: {
    projectId: number;
    name: string;
    description?: string | null;
    nodes: OrchestrationNode[];
    edges: OrchestrationEdge[];
    stateSchema?: object | null;
    inputSchema?: object | null;
  } & OrchestrationVersionAuthorship
): Promise<MappedOrchestration> => {
  log('createOrchestration %o', { projectId: args.projectId, name: args.name });

  assertOrchestrationValid({
    nodes: args.nodes,
    edges: args.edges,
    inputSchema: args.inputSchema,
  });

  const orch = await db.Orchestration.create({
    projectId: args.projectId,
    name: args.name,
    description: args.description ?? null,
    version: 1,
    nodes: args.nodes,
    edges: args.edges,
    stateSchema: args.stateSchema ?? null,
    inputSchema: args.inputSchema ?? null,
  });

  const created = await db.Orchestration.findOne({
    where: { id: orch.id as number },
    include: [{ model: db.Project, as: 'project' }],
  });

  const mapped = mapOrchestration(
    created as InstanceType<typeof db.Orchestration> & {
      project: InstanceType<typeof db.Project>;
    }
  );

  // Version 1 is archived on create, so the very first run has a pinned graph to
  // resolve rather than falling back to the live row.
  await orchestrationVersionStore.writeVersion({
    resourceDbId: orch.id as number,
    version: 1,
    config: buildOrchestrationConfigSnapshot(mapped),
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
  });

  return mapped;
};

export const listOrchestrations = async (args: {
  projectIds: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedOrchestration>> => {
  log('listOrchestrations %o', { projectIds: args.projectIds });

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.Orchestration.findAndCountAll({
        where: { projectId: args.projectIds },
        include: [{ model: db.Project, as: 'project' }],
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapOrchestration(
        row as InstanceType<typeof db.Orchestration> & {
          project: InstanceType<typeof db.Project>;
        }
      );
    },
  });
};

export const findOrchestration = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<MappedOrchestration | null> => {
  log('findOrchestration %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({
    where,
    include: [{ model: db.Project, as: 'project' }],
  });

  if (!orch) return null;

  return mapOrchestration(
    orch as InstanceType<typeof db.Orchestration> & {
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const updateOrchestration = async (
  args: {
    id: string;
    projectIds?: number[];
    name?: string;
    description?: string | null;
    nodes?: OrchestrationNode[];
    edges?: OrchestrationEdge[];
    stateSchema?: object | null;
    inputSchema?: object | null;
  } & OrchestrationVersionAuthorship
): Promise<MappedOrchestration> => {
  log('updateOrchestration %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({
    where,
    include: [{ model: db.Project, as: 'project' }],
  });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.id}' not found.`
    );

  // `orch` is loaded with its project so it can be mapped directly, before and
  // after the write: `update` mutates the instance in place, so the same
  // reference yields the pre-write config here and the post-write one below,
  // with no second query and no chance of the two views disagreeing.
  const asMappable = orch as InstanceType<typeof db.Orchestration> & {
    project: InstanceType<typeof db.Project>;
  };
  const beforeConfig = buildOrchestrationConfigSnapshot(
    mapOrchestration(asMappable)
  );

  assertOrchestrationUpdateValid({
    update: {
      nodes: args.nodes,
      edges: args.edges,
      inputSchema: args.inputSchema,
    },
    persisted: {
      nodes: orch.nodes as OrchestrationNode[],
      edges: orch.edges as OrchestrationEdge[],
      inputSchema: orch.inputSchema as object | null,
    },
  });

  const updates: Record<string, unknown> = {};
  if (args.name !== undefined) updates['name'] = args.name;
  if (args.description !== undefined) updates['description'] = args.description;
  if (args.nodes !== undefined) updates['nodes'] = args.nodes;
  if (args.edges !== undefined) updates['edges'] = args.edges;
  if (args.stateSchema !== undefined) updates['stateSchema'] = args.stateSchema;
  if (args.inputSchema !== undefined) updates['inputSchema'] = args.inputSchema;

  await orch.update(updates);

  // A graph write bumps the version and archives the new graph, so a run pinned
  // to any earlier version still resolves the topology it started on.
  // Metadata-only edits (name / description) leave the version untouched — as
  // does re-writing the graph the orchestration already holds, which is what
  // makes restoring the live graph a genuine no-op rather than an endless
  // version chain.
  await orchestrationVersionStore.archiveConfigChange({
    resourceDbId: orch.id as number,
    currentVersion: orch.version,
    before: beforeConfig,
    after: buildOrchestrationConfigSnapshot(mapOrchestration(asMappable)),
    label: args.versionLabel,
    createdByUserId: args.createdByUserId,
    bumpVersion: async (nextVersion) => {
      await orch.update({ version: nextVersion });
      log(
        'updateOrchestration: id=%s bumped to version=%d',
        args.id,
        nextVersion
      );
    },
  });

  // Mapped last, so the response carries the version the archive just wrote.
  return mapOrchestration(asMappable);
};

export const deleteOrchestration = async (args: {
  id: string;
  projectIds?: number[];
}): Promise<void> => {
  log('deleteOrchestration %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({ where });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.id}' not found.`
    );

  await db.sequelize.transaction(async (t) => {
    const runs = await db.OrchestrationRun.findAll({
      where: { orchestrationId: orch.id as number },
      attributes: ['id'],
      transaction: t,
    });

    const runIds = runs
      .map((run) => {
        return run.id as number;
      })
      .filter((orchestrationRunId) => {
        return Number.isInteger(orchestrationRunId);
      });

    if (runIds.length > 0) {
      await db.OrchestrationCheckpoint.destroy({
        where: { orchestrationRunId: runIds },
        transaction: t,
      });

      await db.OrchestrationNodeExecution.destroy({
        where: { orchestrationRunId: runIds },
        transaction: t,
      });

      await db.OrchestrationRun.destroy({
        where: { id: runIds },
        transaction: t,
      });
    }

    // Archived versions are owned by the orchestration; remove them before the
    // parent so no orphan version rows are left behind.
    await orchestrationVersionStore.deleteVersions({
      resourceDbId: orch.id as number,
      transaction: t,
    });

    await orch.destroy({ transaction: t });
  });
};

// ── CRUD: Orchestration Runs ──────────────────────────────────────────────

export const findOrchestrationRun = async (args: {
  id: string;
  orchestrationId?: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun | null> => {
  log('findOrchestrationRun %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const include: object[] = [
    { model: db.Project, as: 'project' },
    { model: db.Orchestration, as: 'orchestration' },
    nodeExecutionsInclude(),
  ];

  if (args.orchestrationId) {
    include[1] = {
      model: db.Orchestration,
      as: 'orchestration',
      where: { publicId: args.orchestrationId },
    };
  }

  const run = await db.OrchestrationRun.findOne({ where, include });
  if (!run) return null;

  const usage = await getRunUsageTotals({ runInternalId: run.id as number });

  return mapOrchestrationRun(
    run as InstanceType<typeof db.OrchestrationRun> & {
      orchestration: InstanceType<typeof db.Orchestration>;
      project: InstanceType<typeof db.Project>;
    },
    usage
  );
};

export const listOrchestrationRuns = async (args: {
  orchestrationPublicId?: string;
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedOrchestrationRun>> => {
  log('listOrchestrationRuns %o', {
    orchestrationPublicId: args.orchestrationPublicId,
  });

  const where: Record<string, unknown> = {};
  if (args.projectIds) where['projectId'] = args.projectIds;

  // Optional orchestration filter: resolve the orchestration id when provided,
  // returning an empty list if it does not exist within the caller's scope.
  if (args.orchestrationPublicId !== undefined) {
    const orchWhere: Record<string, unknown> = {
      publicId: args.orchestrationPublicId,
    };
    if (args.projectIds) orchWhere['projectId'] = args.projectIds;
    const orch = await db.Orchestration.findOne({ where: orchWhere });
    if (!orch) {
      const { limit, offset } = resolvePagination(args);
      return { data: [], total: 0, limit, offset };
    }
    where['orchestrationId'] = orch.id as number;
  }

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.OrchestrationRun.findAndCountAll({
        where,
        include: [
          { model: db.Project, as: 'project' },
          { model: db.Orchestration, as: 'orchestration' },
          nodeExecutionsInclude(),
        ],
        order: [['createdAt', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapOrchestrationRun(
        row as InstanceType<typeof db.OrchestrationRun> & {
          orchestration: InstanceType<typeof db.Orchestration>;
          project: InstanceType<typeof db.Project>;
        }
      );
    },
  });
};

export { startOrchestrationRun } from './orchestrationEngine';
export type { MappedOrchestrationCheckpoint } from './orchestrationRunActions';
export {
  cancelOrchestrationRun,
  resumeOrchestrationRun,
  submitHumanInput,
} from './orchestrationRunActions';
export { validateOrchestrationGraph } from './orchestrationValidation';
