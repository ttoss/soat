import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { RequiredAction, ScheduledWait } from './orchestrationExecutors';
import {
  detectCycleExcludingLoopNodes,
  findStartNodes,
  processNodeResultBatch,
} from './orchestrationExecutors';
import {
  buildRunError,
  executeAndRecordNode,
  recordSkippedNodeExecutions,
} from './orchestrationNodeRecorder';
import type {
  MappedOrchestrationRun,
  OrchestrationEdge,
  OrchestrationNode,
} from './orchestrations';

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
  scheduledWait: ScheduledWait | null;
  traceId: string | null;
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
  pollAttempts: Map<string, number>;
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
    pollAttempts,
  } = args;

  log('executeRun: activeNodes=%o', activeNodeIds);
  enforceMaxIterations({ activeNodeIds, iterationCount });

  const nodeResults = await Promise.all(
    activeNodeIds.map((nodeId) => {
      return executeAndRecordNode({
        nodeId,
        runRecord,
        nodes,
        state,
        projectIds,
        traceId,
        authHeader,
        pollAttempt: pollAttempts.get(nodeId),
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

  // A scheduled wait (or a pause) stops this loop: no further nodes activate
  // this round. The wait is handled by the caller (persisted for the scheduler,
  // or slept through inline in synchronous mode).
  const stop = runStatus === 'paused' || batch.scheduledWait !== null;
  const nextActiveNodeIds = stop ? [] : batch.nextRound;
  return {
    nextActiveNodeIds,
    runStatus,
    requiredAction,
    scheduledWait: batch.scheduledWait,
    traceId: batch.traceId,
  };
};

export type RunLoopState = {
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  activatedNodes: Set<string>;
  iterationCount: Map<string, number>;
  pollAttempts: Map<string, number>;
  activeNodeIds: string[];
};

const initRunLoopState = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  completedNodes?: Set<string>;
  conditionLabels?: Map<string, string>;
  activatedNodes?: Set<string>;
  iterationCount?: Map<string, number>;
  pollAttempts?: Map<string, number>;
}): RunLoopState => {
  const completedNodes = args.completedNodes ?? new Set<string>();
  const conditionLabels = args.conditionLabels ?? new Map<string, string>();
  const activatedNodes =
    args.activatedNodes ??
    new Set<string>(findStartNodes(args.nodes, args.edges));
  const iterationCount = args.iterationCount ?? new Map<string, number>();
  const pollAttempts = args.pollAttempts ?? new Map<string, number>();
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
    pollAttempts,
    activeNodeIds,
  };
};

// Throws if the graph has a cycle, ignoring `loop` nodes (which legitimately
// re-enter). Kept separate so executeRunLoop stays compact.
const assertNoCycle = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
}): void => {
  if (detectCycleExcludingLoopNodes(args.nodes, args.edges)) {
    throw new DomainError(
      'ORCHESTRATION_CYCLE_DETECTED',
      'Cycle detected in orchestration graph.'
    );
  }
};

export type RunLoopResult = {
  runStatus: MappedOrchestrationRun['status'];
  requiredAction: RequiredAction | null;
  runError: object | null;
  scheduledWait: ScheduledWait | null;
  traceId: string | null;
};

/**
 * Runs one segment of a run: executes activated nodes round by round until the
 * graph settles (completed), a node pauses it (requires_action), or a node
 * parks it on a scheduled wait (delay/poll). Mutates `state`/`artifacts` in
 * place and writes a checkpoint per round; the caller persists the outcome.
 */
export const executeRunLoop = async (args: {
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
  pollAttempts?: Map<string, number>;
}): Promise<RunLoopResult> => {
  const { runRecord, nodes, edges, state, artifacts, projectIds } = args;
  const loopState = initRunLoopState(args);
  let { activeNodeIds } = loopState;
  const { completedNodes, conditionLabels, activatedNodes, iterationCount } =
    loopState;
  const { pollAttempts } = loopState;
  let runStatus: MappedOrchestrationRun['status'] = 'running';
  let runError: object | null = null;
  let requiredAction: RequiredAction | null = null;
  let scheduledWait: ScheduledWait | null = null;
  // The run's own trace id if already set, otherwise the first trace id produced
  // by a traced node (e.g. an `agent` node) — captured so it can be persisted
  // onto the run and used as the parent for subsequent nodes.
  let traceId: string | null = args.traceId;

  try {
    assertNoCycle({ nodes, edges });

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
        authHeader: args.authHeader,
        completedNodes,
        conditionLabels,
        activatedNodes,
        iterationCount,
        pollAttempts,
      });
      activeNodeIds = batchResult.nextActiveNodeIds;
      runStatus = batchResult.runStatus;
      requiredAction = batchResult.requiredAction;
      scheduledWait = batchResult.scheduledWait;
      traceId = traceId ?? batchResult.traceId;
      // A scheduled wait leaves the run 'running' but must break the loop so the
      // caller can offload the wait to the scheduler.
      if (scheduledWait) break;
    }

    if (runStatus === 'running' && !scheduledWait) runStatus = 'completed';
    if (runStatus === 'completed') {
      await recordSkippedNodeExecutions({ runRecord, nodes });
    }
  } catch (error: unknown) {
    runStatus = 'failed';
    runError = buildRunError(error);
    scheduledWait = null;
    log('executeRun error %o', runError);
  }

  return { runStatus, requiredAction, runError, scheduledWait, traceId };
};
