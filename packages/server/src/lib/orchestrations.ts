import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';

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
  | 'delay'
  | 'webhook'
  | 'sub_orchestration';

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
  // loop node
  collection?: string;
  itemVariable?: string;
  subGraph?: string;
  parallelism?: number;
  // delay node — ISO 8601 duration (e.g. PT5S)
  duration?: string;
  // webhook node
  mode?: 'emit' | 'receive';
  webhookUrl?: string;
  // sub_orchestration node
  orchestrationId?: string;
  // Shared: max iterations for cycles
  maxIterations?: number;
  // Shared mappings
  inputMapping?: Record<string, string>;
  outputMapping?: Record<string, string>;
  outputSchema?: object;
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

export type MappedOrchestrationRun = {
  id: string;
  orchestrationId: string;
  projectId: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  state: Record<string, unknown>;
  activeNodes: string[];
  artifacts: Record<string, unknown>;
  error: object | null;
  requiredAction: object | null;
  traceId: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
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

const mapOrchestrationRun = (
  run: InstanceType<typeof db.OrchestrationRun> & {
    orchestration: InstanceType<typeof db.Orchestration>;
    project: InstanceType<typeof db.Project>;
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
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
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

  await orch.destroy();
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
  orchestrationPublicId: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun[]> => {
  log('listOrchestrationRuns %o', {
    orchestrationPublicId: args.orchestrationPublicId,
  });

  const orchWhere: Record<string, unknown> = {
    publicId: args.orchestrationPublicId,
  };
  if (args.projectIds) orchWhere['projectId'] = args.projectIds;

  const orch = await db.Orchestration.findOne({ where: orchWhere });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.orchestrationPublicId}' not found.`
    );

  const rows = await db.OrchestrationRun.findAll({
    where: { orchestrationId: orch.id as number },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
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

// ── Types: Checkpoint ─────────────────────────────────────────────────────

export type MappedOrchestrationCheckpoint = {
  runId: string;
  nodeId: string;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  createdAt: Date;
};

// ── Run actions ───────────────────────────────────────────────────────────

export const cancelOrchestrationRun = async (args: {
  runPublicId: string;
  orchestrationPublicId?: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun> => {
  log('cancelOrchestrationRun %o', { runPublicId: args.runPublicId });

  const where: Record<string, unknown> = { publicId: args.runPublicId };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const include: object[] = [
    { model: db.Project, as: 'project' },
    { model: db.Orchestration, as: 'orchestration' },
  ];

  if (args.orchestrationPublicId) {
    include[1] = {
      model: db.Orchestration,
      as: 'orchestration',
      where: { publicId: args.orchestrationPublicId },
    };
  }

  const run = await db.OrchestrationRun.findOne({ where, include });
  if (!run)
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_FOUND',
      `Run '${args.runPublicId}' not found.`
    );

  if (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled'
  ) {
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_CANCELLABLE',
      `Run '${args.runPublicId}' is already in terminal state '${run.status}'.`
    );
  }

  await run.update({ status: 'cancelled', completedAt: new Date() });

  return mapOrchestrationRun(
    run as InstanceType<typeof db.OrchestrationRun> & {
      orchestration: InstanceType<typeof db.Orchestration>;
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const submitHumanInput = async (args: {
  runPublicId: string;
  orchestrationPublicId?: string;
  projectIds?: number[];
  nodeId: string;
  output: Record<string, unknown>;
}): Promise<MappedOrchestrationRun> => {
  log('submitHumanInput %o', {
    runPublicId: args.runPublicId,
    nodeId: args.nodeId,
  });

  const { resumeOrchestrationRunExecution } =
    await import('./orchestrationEngine');

  const where: Record<string, unknown> = { publicId: args.runPublicId };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const include: object[] = [
    { model: db.Project, as: 'project' },
    {
      model: db.Orchestration,
      as: 'orchestration',
      ...(args.orchestrationPublicId
        ? { where: { publicId: args.orchestrationPublicId } }
        : {}),
    },
  ];

  const run = await db.OrchestrationRun.findOne({ where, include });
  if (!run)
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_FOUND',
      `Run '${args.runPublicId}' not found.`
    );

  if (run.status !== 'paused')
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_PAUSED',
      `Run '${args.runPublicId}' is not paused (status: '${run.status}').`
    );

  const activeNodes = run.activeNodes as string[];
  if (!activeNodes.includes(args.nodeId))
    throw new DomainError(
      'ORCHESTRATION_HUMAN_NODE_MISMATCH',
      `Node '${args.nodeId}' is not the active human node for run '${args.runPublicId}'.`
    );

  return resumeOrchestrationRunExecution({
    run,
    humanNodeId: args.nodeId,
    humanOutput: args.output,
  });
};

export const resumeOrchestrationRun = async (args: {
  runPublicId: string;
  orchestrationPublicId?: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun> => {
  log('resumeOrchestrationRun %o', { runPublicId: args.runPublicId });

  const { resumeOrchestrationRunExecution } =
    await import('./orchestrationEngine');

  const where: Record<string, unknown> = { publicId: args.runPublicId };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const include: object[] = [
    { model: db.Project, as: 'project' },
    {
      model: db.Orchestration,
      as: 'orchestration',
      ...(args.orchestrationPublicId
        ? { where: { publicId: args.orchestrationPublicId } }
        : {}),
    },
  ];

  const run = await db.OrchestrationRun.findOne({ where, include });
  if (!run)
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_FOUND',
      `Run '${args.runPublicId}' not found.`
    );

  if (run.status !== 'paused')
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_PAUSED',
      `Run '${args.runPublicId}' is not paused (status: '${run.status}').`
    );

  return resumeOrchestrationRunExecution({ run });
};
