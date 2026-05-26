import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { RequiredAction } from './orchestrationExecutors';
import {
  applyOutputMapping,
  executeNodeById,
  findStartNodes,
  processNodeResultBatch,
  resolveNextNodes,
} from './orchestrationExecutors';
import type {
  MappedOrchestrationRun,
  OrchestrationEdge,
  OrchestrationNode,
} from './orchestrations';

const log = createDebug('soat:orchestrations');

const mapRunWithIncludes = async (
  runId: number
): Promise<MappedOrchestrationRun> => {
  const finalRun = await db.OrchestrationRun.findOne({
    where: { id: runId },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
    ],
  });

  const run = finalRun as InstanceType<typeof db.OrchestrationRun> & {
    orchestration: InstanceType<typeof db.Orchestration>;
    project: InstanceType<typeof db.Project>;
  };

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

const MAX_ITERATIONS = 100;

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

  const completedNodes = args.completedNodes ?? new Set<string>();
  const conditionLabels = args.conditionLabels ?? new Map<string, string>();
  const activatedNodes =
    args.activatedNodes ?? new Set<string>(findStartNodes(nodes, edges));
  const iterationCount = args.iterationCount ?? new Map<string, number>();
  let activeNodeIds = args.activatedNodes
    ? [...activatedNodes].filter((n) => {
        return !completedNodes.has(n);
      })
    : [...activatedNodes];
  let runStatus: MappedOrchestrationRun['status'] = 'running';
  let runError: object | null = null;
  let requiredAction: RequiredAction | null = null;

  try {
    // Detect cycles via DFS before executing — only for non-loop node graphs
    const hasLoopNodes = nodes.some((n) => {
      return n.type === 'loop';
    });
    if (!hasLoopNodes) {
      const adj = new Map<string, string[]>();
      for (const node of nodes) adj.set(node.id, []);
      for (const edge of edges) {
        const targets = adj.get(edge.from);
        if (targets) targets.push(edge.to);
      }
      const WHITE = 0,
        GRAY = 1,
        BLACK = 2;
      const color = new Map<string, number>(
        nodes.map((n) => {
          return [n.id, WHITE];
        })
      );
      const dfs = (u: string): boolean => {
        color.set(u, GRAY);
        for (const v of adj.get(u) ?? []) {
          if (color.get(v) === GRAY) return true;
          if (color.get(v) === WHITE && dfs(v)) return true;
        }
        color.set(u, BLACK);
        return false;
      };
      for (const node of nodes) {
        if (color.get(node.id) === WHITE && dfs(node.id)) {
          throw new DomainError(
            'ORCHESTRATION_CYCLE_DETECTED',
            'Cycle detected in orchestration graph.'
          );
        }
      }
    }

    while (activeNodeIds.length > 0 && runStatus === 'running') {
      log('executeRun: activeNodes=%o', activeNodeIds);

      // Enforce max iterations for cycles
      for (const nodeId of activeNodeIds) {
        const count = (iterationCount.get(nodeId) ?? 0) + 1;
        iterationCount.set(nodeId, count);
        if (count > MAX_ITERATIONS) {
          throw new DomainError(
            'ORCHESTRATION_MAX_ITERATIONS_EXCEEDED',
            `Node '${nodeId}' exceeded maximum iteration count (${MAX_ITERATIONS}).`
          );
        }
      }

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
        isRunning: runStatus === 'running',
      });

      if (batch.requiredAction) {
        runStatus = 'paused';
        requiredAction = batch.requiredAction;
      }

      // Write checkpoint after each batch
      const lastNodeId = activeNodeIds[activeNodeIds.length - 1];
      await db.OrchestrationCheckpoint.create({
        runId: runRecord.id as number,
        nodeId: lastNodeId,
        state: { ...state },
        artifacts: { ...artifacts },
      });

      activeNodeIds = runStatus === 'running' ? batch.nextRound : [];
    }

    if (runStatus === 'running') runStatus = 'completed';
  } catch (error: unknown) {
    runStatus = 'failed';
    runError = {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof DomainError ? error.code : 'UNKNOWN',
    };
    log('executeRun error %o', runError);
  }

  return { runStatus, requiredAction, runError };
};

const getTerminalOutput = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  artifacts: Record<string, unknown>;
}): Record<string, unknown> => {
  const { nodes, edges, artifacts } = args;
  const output: Record<string, unknown> = {};
  const terminalIds = nodes
    .map((n) => {
      return n.id;
    })
    .filter((id) => {
      return !edges.some((e) => {
        return e.from === id;
      });
    });
  for (const id of terminalIds) {
    if (artifacts[id] !== undefined) output[id] = artifacts[id];
  }
  return output;
};

const updateRunRecord = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  runStatus: MappedOrchestrationRun['status'];
  requiredAction: RequiredAction | null;
  runError: object | null;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  output: Record<string, unknown>;
}): Promise<void> => {
  const {
    runRecord,
    runStatus,
    requiredAction,
    runError,
    state,
    artifacts,
    output,
  } = args;
  const isTerminal = runStatus === 'completed' || runStatus === 'failed';
  await runRecord.update({
    status: runStatus,
    state,
    activeNodes: runStatus === 'paused' ? [requiredAction?.nodeId ?? ''] : [],
    artifacts,
    error: runError,
    requiredAction: runStatus === 'paused' ? requiredAction : null,
    output: runStatus === 'completed' ? output : null,
    completedAt: isTerminal ? new Date() : null,
  });
};

export const startOrchestrationRun = async (args: {
  orchestrationPublicId: string;
  projectId: number;
  projectIds: number[];
  input?: Record<string, unknown>;
  authHeader?: string;
}): Promise<MappedOrchestrationRun> => {
  log('startOrchestrationRun %o', {
    orchestrationPublicId: args.orchestrationPublicId,
  });

  const orch = await db.Orchestration.findOne({
    where: {
      publicId: args.orchestrationPublicId,
      projectId: args.projectIds,
    },
  });
  if (!orch)
    throw new DomainError(
      'ORCHESTRATION_NOT_FOUND',
      `Orchestration '${args.orchestrationPublicId}' not found.`
    );

  const nodes = orch.nodes as OrchestrationNode[];
  const edges = orch.edges as OrchestrationEdge[];
  const state: Record<string, unknown> = { ...(args.input ?? {}) };
  const artifacts: Record<string, unknown> = {};

  const runRecord = await db.OrchestrationRun.create({
    orchestrationId: orch.id as number,
    projectId: args.projectId,
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
    projectIds: args.projectIds,
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

  if (runStatus === 'paused' && requiredAction) {
    (
      mapped as MappedOrchestrationRun & { requiredAction?: RequiredAction }
    ).requiredAction = requiredAction;
  }

  return mapped;
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

  // Restore execution context from the last checkpoint
  const checkpoint = await db.OrchestrationCheckpoint.findOne({
    where: { runId: run.id as number },
    order: [['createdAt', 'DESC']],
  });

  const restoredState = checkpoint
    ? (checkpoint.state as Record<string, unknown>)
    : state;
  const restoredArtifacts = checkpoint
    ? (checkpoint.artifacts as Record<string, unknown>)
    : artifacts;

  // Merge restored state back
  Object.assign(state, restoredState);
  Object.assign(artifacts, restoredArtifacts);

  // Apply human input output mapping
  if (humanNodeId && humanOutput) {
    const humanNode = nodes.find((n) => {
      return n.id === humanNodeId;
    });
    if (humanNode) {
      applyOutputMapping(humanNode.outputMapping, humanOutput, state);
    }
    artifacts[humanNodeId] = humanOutput;
  }

  // Figure out active nodes to resume from
  // If human input was submitted, continue from nodes after the human node
  // Otherwise, use the run's activeNodes
  const activeNodes = run.activeNodes as string[];
  const completedNodes = new Set<string>(
    Object.keys(artifacts).concat(humanNodeId ? [humanNodeId] : [])
  );

  // Build the starting set for the next round from edges leaving the human node or the activeNodes
  const conditionLabels = new Map<string, string>();

  let startNodeIds: string[];
  if (humanNodeId) {
    const resolved = resolveNextNodes({
      completedNodeId: humanNodeId,
      completedNodes,
      conditionLabels,
      edges,
    });
    startNodeIds = resolved;
  } else {
    startNodeIds = activeNodes;
  }

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
