/* eslint-disable max-lines */
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import {
  nodeExecutionsInclude,
  type OrchestrationRunRow,
  orchestrationRuns,
  orchestrations,
} from './orchestrationAccessor';
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
import { getRunUsageRollups, type UsageTotals } from './usageReceipt';

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
  // approval node — parks the run as `awaiting_input` until a human resolves
  // the proposed call or it expires. `arguments` and the evidence fields are
  // JSON Logic resolved against run state at emit time.
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
  // loop / sub_orchestration node — narrows the run's `tool_context` before it
  // is handed to the child run, the way a tool's `contextKeys` narrows what
  // egresses to it (#1153). `undefined`/`null` inherits everything.
  contextKeys?: string[] | null;
  // poll node — reuses the tool fields above; `exitCondition` is JSON Logic,
  // truthy to stop.
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
  // emit_event node — emits an internal domain event that subscribed Webhooks
  // deliver, so a graph never holds a URL or secret of its own. Fire-and-forget:
  // the run neither blocks on nor fails from the delivery outcome.
  eventType?: string;
  // sub_orchestration node
  orchestrationId?: string;
  // Shared: max iterations for cycles
  maxIterations?: number;
  // JSON Logic (literal or expression). `stateMapping` keys are write
  // destinations, mirroring `inputMapping`'s read-source shape.
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
  // The caller context the run carries for its whole lifetime, forwarded as
  // `X-Soat-Context-*` headers on the tool calls of every agent generation the
  // run spawns. An opaque bag: copied as a value, its keys never re-cased.
  tool_context: Record<string, string> | null;
  // Caller-owned annotations supplied at run creation, returned verbatim and
  // never merged into `state`. An opaque bag: copied as a value, its keys never
  // re-cased, and no key reserved — the engine reads nothing from here.
  metadata: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  // Set only on a `loop` / `sub_orchestration` child. Qualified by its
  // resource, like every other run id on the wire: SOAT has three unrelated
  // run concepts, so a bare `parent_run_id` invites pasting into the wrong flag.
  parent_orchestration_run_id: string | null;
  parent_node_id: string | null;
  // `loop` / `sub_orchestration` edges between this run and the one a caller
  // started; 0 for a caller-started run. What the depth bound counts (#1185).
  run_depth: number;
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
  // The roll-up summed over this run and every descendant, so it equals `usage`
  // only for a run with no children.
  usage_own?: {
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

const mapNodeExecution = (
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
  // The subtree total (what the run cost) and this run's own nodes.
  usage?: UsageTotals,
  ownUsage?: UsageTotals
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
    tool_context: run.toolContext ?? null,
    metadata: run.metadata ?? null,
    output: run.output as Record<string, unknown> | null,
    parent_orchestration_run_id: run.parentRunId,
    parent_node_id: run.parentNodeId,
    run_depth: run.runDepth,
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
    ...(ownUsage
      ? {
          usage_own: {
            total_input_tokens: ownUsage.totalInputTokens,
            total_output_tokens: ownUsage.totalOutputTokens,
            total_cached_tokens: ownUsage.totalCachedTokens,
            total_reasoning_tokens: ownUsage.totalReasoningTokens,
            total_cost_usd: ownUsage.totalCostUsd,
          },
        }
      : {}),
    started_at: run.startedAt,
    completed_at: run.completedAt,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
};

export { nodeExecutionsInclude } from './orchestrationAccessor';

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

  const orch = await orchestrations.findByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });

  if (!orch) return null;

  return mapOrchestration(orch);
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

  const orch = await orchestrations.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });

  // `update` mutates the instance in place, so this one reference yields both
  // the pre- and post-write config with no second query and no chance of the
  // two views disagreeing.
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

  // A graph write bumps the version, so a run pinned to an earlier one still
  // resolves the topology it started on. Metadata-only edits and re-writing the
  // identical graph leave it untouched — restoring the live graph is a genuine
  // no-op rather than an endless version chain.
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

  const orch = await orchestrations.getByPublicId({
    id: args.id,
    projectIds: args.projectIds,
  });

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

  // Built per call rather than taken from the accessor because the includes
  // vary; the scoped `where` is the part that must not.
  const include: object[] = [
    { model: db.Project, as: 'project' },
    args.orchestrationId
      ? {
          model: db.Orchestration,
          as: 'orchestration',
          where: { publicId: args.orchestrationId },
        }
      : { model: db.Orchestration, as: 'orchestration' },
    nodeExecutionsInclude(),
  ];

  const run = (await db.OrchestrationRun.findOne({
    where: orchestrationRuns.scopedWhere({
      id: args.id,
      projectIds: args.projectIds,
    }),
    include,
  })) as OrchestrationRunRow | null;
  if (!run) return null;

  // `usage` is the subtree figure and `usage_own` the run's own nodes — both
  // from one pass, so the split costs no extra query (#1135).
  const rollups = await getRunUsageRollups({
    runInternalId: run.id as number,
    runPublicId: run.publicId as string,
  });

  return mapOrchestrationRun(run, rollups.includingNested, rollups.own);
};

export const listOrchestrationRuns = async (args: {
  orchestrationPublicId?: string;
  // Without this a caller holding a parent could not name its children, which
  // let a parent's total read as complete when it was not (#1135).
  parentRunId?: string;
  // Makes an aggregate over runs safe: `usage` is transitive, so summing it
  // across a list mixing parents and children counts the children twice.
  nested?: boolean;
  projectIds?: number[];
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<MappedOrchestrationRun>> => {
  log('listOrchestrationRuns %o', {
    orchestrationPublicId: args.orchestrationPublicId,
  });

  const where: Record<string, unknown> = {};
  if (args.projectIds) where['projectId'] = args.projectIds;
  if (args.parentRunId !== undefined) {
    where['parentRunId'] = args.parentRunId;
  } else if (args.nested !== undefined) {
    where['parentRunId'] = args.nested ? { [Op.ne]: null } : null;
  }

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
