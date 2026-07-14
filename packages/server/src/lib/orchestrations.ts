/* eslint-disable max-lines */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  assertOrchestrationUpdateValid,
  assertOrchestrationValid,
} from './orchestrationValidation';

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
  | 'loop'
  | 'poll'
  | 'delay'
  | 'webhook'
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
  // webhook node
  mode?: 'emit' | 'receive';
  webhookUrl?: string;
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

export type MappedOrchestration = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  stateSchema: object | null;
  inputSchema: object | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MappedNodeExecution = {
  nodeId: string;
  nodeType: string | null;
  attempt: number;
  status: 'completed' | 'failed' | 'requires_action' | 'skipped';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: object | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type MappedOrchestrationRun = {
  id: string;
  orchestrationId: string;
  projectId: string;
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
  activeNodes: string[];
  artifacts: Record<string, unknown>;
  error: object | null;
  requiredAction: object | null;
  traceId: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  nodeExecutions: MappedNodeExecution[];
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// ── Map helpers ───────────────────────────────────────────────────────────

const mapOrchestration = (
  orch: InstanceType<typeof db.Orchestration> & {
    project: InstanceType<typeof db.Project>;
  }
): MappedOrchestration => {
  return {
    id: orch.publicId,
    projectId: orch.project.publicId,
    name: orch.name,
    description: orch.description,
    nodes: orch.nodes as OrchestrationNode[],
    edges: orch.edges as OrchestrationEdge[],
    stateSchema: orch.stateSchema,
    inputSchema: orch.inputSchema,
    createdAt: orch.createdAt,
    updatedAt: orch.updatedAt,
  };
};

export const mapNodeExecution = (
  exec: InstanceType<typeof db.OrchestrationNodeExecution>
): MappedNodeExecution => {
  return {
    nodeId: exec.nodeId,
    nodeType: exec.nodeType,
    attempt: exec.attempt,
    status: exec.status,
    input: exec.input as Record<string, unknown> | null,
    output: exec.output as Record<string, unknown> | null,
    error: exec.error,
    startedAt: exec.startedAt,
    completedAt: exec.completedAt,
    createdAt: exec.createdAt,
  };
};

export const mapOrchestrationRun = (
  run: InstanceType<typeof db.OrchestrationRun> & {
    orchestration: InstanceType<typeof db.Orchestration>;
    project: InstanceType<typeof db.Project>;
    nodeExecutions?: InstanceType<typeof db.OrchestrationNodeExecution>[];
  }
): MappedOrchestrationRun => {
  return {
    id: run.publicId,
    orchestrationId: run.orchestration.publicId,
    projectId: run.project.publicId,
    status: run.status,
    state: run.state as Record<string, unknown>,
    activeNodes: run.activeNodes as string[],
    artifacts: run.artifacts as Record<string, unknown>,
    error: run.error,
    requiredAction: run.requiredAction as object | null,
    traceId: run.traceId,
    input: run.input as Record<string, unknown> | null,
    output: run.output as Record<string, unknown> | null,
    nodeExecutions: (run.nodeExecutions ?? []).map(mapNodeExecution),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
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

export const createOrchestration = async (args: {
  projectId: number;
  name: string;
  description?: string | null;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  stateSchema?: object | null;
  inputSchema?: object | null;
}): Promise<MappedOrchestration> => {
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
    nodes: args.nodes,
    edges: args.edges,
    stateSchema: args.stateSchema ?? null,
    inputSchema: args.inputSchema ?? null,
  });

  const created = await db.Orchestration.findOne({
    where: { id: orch.id as number },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapOrchestration(
    created as InstanceType<typeof db.Orchestration> & {
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const listOrchestrations = async (args: {
  projectIds: number[];
}): Promise<MappedOrchestration[]> => {
  log('listOrchestrations %o', { projectIds: args.projectIds });

  const rows = await db.Orchestration.findAll({
    where: { projectId: args.projectIds },
    include: [{ model: db.Project, as: 'project' }],
    order: [['createdAt', 'DESC']],
  });

  return rows.map((row) => {
    return mapOrchestration(
      row as InstanceType<typeof db.Orchestration> & {
        project: InstanceType<typeof db.Project>;
      }
    );
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

export const updateOrchestration = async (args: {
  id: string;
  projectIds?: number[];
  name?: string;
  description?: string | null;
  nodes?: OrchestrationNode[];
  edges?: OrchestrationEdge[];
  stateSchema?: object | null;
  inputSchema?: object | null;
}): Promise<MappedOrchestration> => {
  log('updateOrchestration %o', { id: args.id });

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({ where });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.id}' not found.`
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

  const updated = await db.Orchestration.findOne({
    where: { id: orch.id as number },
    include: [{ model: db.Project, as: 'project' }],
  });

  return mapOrchestration(
    updated as InstanceType<typeof db.Orchestration> & {
      project: InstanceType<typeof db.Project>;
    }
  );
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
      .filter((runId) => {
        return Number.isInteger(runId);
      });

    if (runIds.length > 0) {
      await db.OrchestrationCheckpoint.destroy({
        where: { runId: runIds },
        transaction: t,
      });

      await db.OrchestrationNodeExecution.destroy({
        where: { runId: runIds },
        transaction: t,
      });

      await db.OrchestrationRun.destroy({
        where: { id: runIds },
        transaction: t,
      });
    }

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

  return mapOrchestrationRun(
    run as InstanceType<typeof db.OrchestrationRun> & {
      orchestration: InstanceType<typeof db.Orchestration>;
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const listOrchestrationRuns = async (args: {
  orchestrationPublicId?: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun[]> => {
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
    if (!orch) return [];
    where['orchestrationId'] = orch.id as number;
  }

  const rows = await db.OrchestrationRun.findAll({
    where,
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
      nodeExecutionsInclude(),
    ],
    order: [['createdAt', 'DESC']],
  });

  return rows.map((row) => {
    return mapOrchestrationRun(
      row as InstanceType<typeof db.OrchestrationRun> & {
        orchestration: InstanceType<typeof db.Orchestration>;
        project: InstanceType<typeof db.Project>;
      }
    );
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
