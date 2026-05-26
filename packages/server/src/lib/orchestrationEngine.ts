import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { RequiredAction } from './orchestrationExecutors';
import {
  detectCycle,
  executeNodeById,
  findStartNodes,
  processNodeResultBatch,
} from './orchestrationExecutors';
import {
  applyHumanInputToState,
  getTerminalOutput,
  mapRunWithIncludes,
  resolveResumeStartNodes,
  restoreRunFromCheckpoint,
  updateRunRecord,
} from './orchestrationRunHelpers';
import type {
  MappedOrchestrationRun,
  OrchestrationEdge,
  OrchestrationNode,
} from './orchestrations';
import {
  attachRequiredActionToRun,
  findOrchestrationForStartRun,
  resolveStartRunProjectScope,
} from './orchestrationStartRun';

const log = createDebug('soat:orchestrations');

const MAX_ITERATIONS = 100;

const enforceMaxIterations = (args: {
  activeNodeIds: string[];
  iterationCount: Map<string, number>;
}): void => {
  for (const nodeId of args.activeNodeIds) {
    const count = (args.iterationCount.get(nodeId) ?? 0) + 1;
    args.iterationCount.set(nodeId, count);
    if (count > MAX_ITERATIONS) {
      throw new DomainError(
        'ORCHESTRATION_MAX_ITERATIONS_EXCEEDED',
        `Node '${nodeId}' exceeded maximum iteration count (${MAX_ITERATIONS}).`
      );
    }
  }
};

const writeRunCheckpoint = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodeId: string;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
}): Promise<void> => {
  await db.OrchestrationCheckpoint.create({
    runId: args.runRecord.id as number,
    nodeId: args.nodeId,
    state: { ...args.state },
    artifacts: { ...args.artifacts },
  });
};

type RunBatchResult = {
  nextActiveNodeIds: string[];
  runStatus: 'running' | 'paused';
  requiredAction: RequiredAction | null;
};

const executeRunBatch = async (args: {
  activeNodeIds: string[];
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  activatedNodes: Set<string>;
  iterationCount: Map<string, number>;
}): Promise<RunBatchResult> => {
  const {
    activeNodeIds,
    runRecord,
    nodes,
    edges,
    state,
    artifacts,
    projectIds,
    traceId,
    authHeader,
    completedNodes,
    conditionLabels,
    activatedNodes,
    iterationCount,
  } = args;

  log('executeRun: activeNodes=%o', activeNodeIds);
  enforceMaxIterations({ activeNodeIds, iterationCount });

  const nodeResults = await Promise.all(
    activeNodeIds.map((nodeId) => {
      return executeNodeById({
        nodeId,
        nodes,
        state,
        projectIds,
        traceId,
        authHeader,
      });
    })
  );

  const batch = processNodeResultBatch({
    nodeResults,
    artifacts,
    conditionLabels,
    completedNodes,
    activatedNodes,
    state,
    edges,
    isRunning: true,
  });

  let runStatus: 'running' | 'paused' = 'running';
  let requiredAction: RequiredAction | null = null;
  if (batch.requiredAction) {
    runStatus = 'paused';
    requiredAction = batch.requiredAction;
  }

  const lastNodeId = activeNodeIds[activeNodeIds.length - 1];
  await writeRunCheckpoint({ runRecord, nodeId: lastNodeId, state, artifacts });

  const nextActiveNodeIds = runStatus === 'running' ? batch.nextRound : [];
  return { nextActiveNodeIds, runStatus, requiredAction };
};

type RunLoopState = {
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  activatedNodes: Set<string>;
  iterationCount: Map<string, number>;
  activeNodeIds: string[];
};

const initRunLoopState = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  completedNodes?: Set<string>;
  conditionLabels?: Map<string, string>;
  activatedNodes?: Set<string>;
  iterationCount?: Map<string, number>;
}): RunLoopState => {
  const completedNodes = args.completedNodes ?? new Set<string>();
  const conditionLabels = args.conditionLabels ?? new Map<string, string>();
  const activatedNodes =
    args.activatedNodes ??
    new Set<string>(findStartNodes(args.nodes, args.edges));
  const iterationCount = args.iterationCount ?? new Map<string, number>();
  const activeNodeIds = args.activatedNodes
    ? [...activatedNodes].filter((n) => {
        return !completedNodes.has(n);
      })
    : [...activatedNodes];
  return {
    completedNodes,
    conditionLabels,
    activatedNodes,
    iterationCount,
    activeNodeIds,
  };
};

const buildRunError = (error: unknown): object => {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error instanceof DomainError ? error.code : 'UNKNOWN',
  };
};

const executeRunLoop = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  completedNodes?: Set<string>;
  conditionLabels?: Map<string, string>;
  activatedNodes?: Set<string>;
  iterationCount?: Map<string, number>;
}): Promise<{
  runStatus: MappedOrchestrationRun['status'];
  requiredAction: RequiredAction | null;
  runError: object | null;
}> => {
  const {
    runRecord,
    nodes,
    edges,
    state,
    artifacts,
    projectIds,
    traceId,
    authHeader,
  } = args;
  const loopState = initRunLoopState(args);
  let { activeNodeIds } = loopState;
  const { completedNodes, conditionLabels, activatedNodes, iterationCount } =
    loopState;
  let runStatus: MappedOrchestrationRun['status'] = 'running';
  let runError: object | null = null;
  let requiredAction: RequiredAction | null = null;

  try {
    if (
      !nodes.some((n) => {
        return n.type === 'loop';
      }) &&
      detectCycle(nodes, edges)
    ) {
      throw new DomainError(
        'ORCHESTRATION_CYCLE_DETECTED',
        'Cycle detected in orchestration graph.'
      );
    }

    while (activeNodeIds.length > 0 && runStatus === 'running') {
      const batchResult = await executeRunBatch({
        activeNodeIds,
        runRecord,
        nodes,
        edges,
        state,
        artifacts,
        projectIds,
        traceId,
        authHeader,
        completedNodes,
        conditionLabels,
        activatedNodes,
        iterationCount,
      });
      activeNodeIds = batchResult.nextActiveNodeIds;
      runStatus = batchResult.runStatus;
      requiredAction = batchResult.requiredAction;
    }

    if (runStatus === 'running') runStatus = 'completed';
  } catch (error: unknown) {
    runStatus = 'failed';
    runError = buildRunError(error);
    log('executeRun error %o', runError);
  }

  return { runStatus, requiredAction, runError };
};

export const startOrchestrationRun = async (args: {
  orchestrationPublicId: string;
  projectId?: number;
  projectIds?: number[];
  input?: Record<string, unknown>;
  authHeader?: string;
}): Promise<MappedOrchestrationRun> => {
  log('startOrchestrationRun %o', {
    orchestrationPublicId: args.orchestrationPublicId,
  });

  const orch = await findOrchestrationForStartRun({
    orchestrationPublicId: args.orchestrationPublicId,
    projectIds: args.projectIds,
  });
  const { effectiveProjectId, effectiveProjectIds } =
    resolveStartRunProjectScope({
      projectId: args.projectId,
      projectIds: args.projectIds,
      orchestrationProjectId: orch.projectId as number,
    });

  const nodes = orch.nodes as OrchestrationNode[];
  const edges = orch.edges as OrchestrationEdge[];
  const state: Record<string, unknown> = { ...(args.input ?? {}) };
  const artifacts: Record<string, unknown> = {};

  const runRecord = await db.OrchestrationRun.create({
    orchestrationId: orch.id as number,
    projectId: effectiveProjectId,
    status: 'running',
    state,
    activeNodes: [],
    artifacts,
    input: args.input ?? null,
    startedAt: new Date(),
  });

  const { runStatus, requiredAction, runError } = await executeRunLoop({
    runRecord,
    nodes,
    edges,
    state,
    artifacts,
    projectIds: effectiveProjectIds,
    traceId: runRecord.traceId ?? null,
    authHeader: args.authHeader,
  });

  const output = getTerminalOutput({ nodes, edges, artifacts });

  await updateRunRecord({
    runRecord,
    runStatus,
    requiredAction,
    runError,
    state,
    artifacts,
    output,
  });

  const mapped = await mapRunWithIncludes(runRecord.id as number);

  return attachRequiredActionToRun({
    mapped,
    runStatus,
    requiredAction,
  });
};

export const resumeOrchestrationRunExecution = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
  humanNodeId?: string;
  humanOutput?: Record<string, unknown>;
}): Promise<MappedOrchestrationRun> => {
  const { run, humanNodeId, humanOutput } = args;
  log('resumeOrchestrationRunExecution %o', { runId: run.id, humanNodeId });

  const orch = await db.Orchestration.findOne({
    where: { id: run.orchestrationId as number },
  });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration for run not found.`
    );

  const nodes = orch.nodes as OrchestrationNode[];
  const edges = orch.edges as OrchestrationEdge[];
  const state = (run.state ?? {}) as Record<string, unknown>;
  const artifacts = (run.artifacts ?? {}) as Record<string, unknown>;

  await restoreRunFromCheckpoint({ runId: run.id as number, state, artifacts });

  if (humanNodeId && humanOutput) {
    applyHumanInputToState({
      humanNodeId,
      humanOutput,
      nodes,
      state,
      artifacts,
    });
  }

  const activeNodes = run.activeNodes as string[];
  const completedNodes = new Set<string>(
    Object.keys(artifacts).concat(humanNodeId ? [humanNodeId] : [])
  );
  const conditionLabels = new Map<string, string>();
  const startNodeIds = resolveResumeStartNodes({
    humanNodeId,
    activeNodes,
    completedNodes,
    conditionLabels,
    edges,
  });

  await run.update({ status: 'running', activeNodes: startNodeIds });

  const activatedNodes = new Set<string>(startNodeIds);
  const projectIds = [run.projectId as number];

  const { runStatus, requiredAction, runError } = await executeRunLoop({
    runRecord: run,
    nodes,
    edges,
    state,
    artifacts,
    projectIds,
    traceId: run.traceId ?? null,
    completedNodes,
    conditionLabels,
    activatedNodes,
  });

  const output = getTerminalOutput({ nodes, edges, artifacts });

  await updateRunRecord({
    runRecord: run,
    runStatus,
    requiredAction,
    runError,
    state,
    artifacts,
    output,
  });

  const mapped = await mapRunWithIncludes(run.id as number);

  if (runStatus === 'paused' && requiredAction) {
    (
      mapped as MappedOrchestrationRun & { requiredAction?: RequiredAction }
    ).requiredAction = requiredAction;
  }

  return mapped;
};
