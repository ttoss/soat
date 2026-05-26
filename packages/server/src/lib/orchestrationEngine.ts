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
    traceId: run.traceId,
    input: run.input as Record<string, unknown> | null,
    output: run.output as Record<string, unknown> | null,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
};

const executeRunLoop = async (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
}): Promise<{
  runStatus: MappedOrchestrationRun['status'];
  requiredAction: RequiredAction | null;
  runError: object | null;
}> => {
  const { nodes, edges, state, artifacts, projectIds, traceId, authHeader } =
    args;

  if (detectCycle(nodes, edges)) {
    return {
      runStatus: 'failed',
      requiredAction: null,
      runError: {
        code: 'ORCHESTRATION_CYCLE_DETECTED',
        message:
          'Orchestration graph contains a cycle. Cycles are not supported.',
      },
    };
  }

  const completedNodes = new Set<string>();
  const conditionLabels = new Map<string, string>();
  const activatedNodes = new Set<string>(findStartNodes(nodes, edges));
  let activeNodeIds = [...activatedNodes];
  let runStatus: MappedOrchestrationRun['status'] = 'running';
  let runError: object | null = null;
  let requiredAction: RequiredAction | null = null;

  try {
    while (activeNodeIds.length > 0 && runStatus === 'running') {
      log('executeRun: activeNodes=%o', activeNodeIds);

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
