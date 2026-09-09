import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { processNodeResultBatch } from './orchestrationBatchResults';
import {
  detectCycleExcludingLoopNodes,
  findStartNodes,
} from './orchestrationGraph';
import { newLeaseExpiry } from './orchestrationLease';
import {
  buildRunError,
  executeAndRecordNode,
  recordSkippedNodeExecutions,
} from './orchestrationNodeRecorder';
import type { RequiredAction, ScheduledWait } from './orchestrationNodeTypes';
import { readRunPause } from './orchestrationRunPause';
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
    orchestrationRunId: args.runRecord.id as number,
    nodeId: args.nodeId,
    state: { ...args.state },
    artifacts: { ...args.artifacts },
  });
  // Progress was made this round, so extend the lease: the reaper only reclaims
  // a `running` run whose lease has expired (i.e. whose driver stopped making
  // progress). Refreshing per round means a healthy long run is never reclaimed.
  await args.runRecord.update({ leaseExpiresAt: newLeaseExpiry() });
};

/**
 * The operator pause to stop at this round's checkpoint, or null.
 *
 * The checkpoint is the pause's boundary: the round's work is durable, so the
 * frontier can be parked and re-driven without repeating any of it (#1237). The
 * flag is re-read here rather than taken off the loaded row, because a request
 * writes it while this loop runs.
 *
 * A node's own park and a scheduled wait take precedence — the node has already
 * said what the run waits for, and the pause stays in force behind it
 * (`submitHumanInput` refuses while it does, and the caller parks a scheduled
 * wait on the pause). So does a settled frontier: pausing a run with nothing
 * left to activate would strand one that has finished.
 */
const readPauseAtCheckpoint = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  runStatus: 'running' | 'awaiting_input';
  scheduledWait: ScheduledWait | null;
  nextRound: string[];
}): Promise<{ reason: string | null } | null> => {
  if (args.runStatus !== 'running') return null;
  if (args.scheduledWait !== null) return null;
  if (args.nextRound.length === 0) return null;
  const pause = await readRunPause({
    orchestrationRunId: args.runRecord.id as number,
  });
  return pause.paused ? { reason: pause.reason } : null;
};

type RunBatchResult = {
  nextActiveNodeIds: string[];
  runStatus: 'running' | 'awaiting_input';
  requiredAction: RequiredAction | null;
  scheduledWait: ScheduledWait | null;
  traceId: string | null;
  /**
   * Set when an operator pause was in force at this round's checkpoint, so the
   * caller parks the run instead of activating `nextActiveNodeIds`. The reason
   * travels with it because the caller writes the `required_action`.
   */
  pauseReason: { reason: string | null } | null;
};

/** Executes this round's activated nodes concurrently, recording each. */
const executeActiveNodes = (args: {
  activeNodeIds: string[];
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodes: OrchestrationNode[];
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  pollAttempts: Map<string, number>;
  retryAttempts: Map<string, number>;
}) => {
  return Promise.all(
    args.activeNodeIds.map((nodeId) => {
      return executeAndRecordNode({
        nodeId,
        runRecord: args.runRecord,
        nodes: args.nodes,
        state: args.state,
        projectIds: args.projectIds,
        traceId: args.traceId,
        authHeader: args.authHeader,
        pollAttempt: args.pollAttempts.get(nodeId),
        retryAttempt: args.retryAttempts.get(nodeId),
      });
    })
  );
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
  retryAttempts: Map<string, number>;
}): Promise<RunBatchResult> => {
  const {
    activeNodeIds,
    runRecord,
    edges,
    state,
    artifacts,
    completedNodes,
    conditionLabels,
    activatedNodes,
    iterationCount,
  } = args;

  log('executeRun: activeNodes=%o', activeNodeIds);
  enforceMaxIterations({ activeNodeIds, iterationCount });

  const nodeResults = await executeActiveNodes(args);

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

  let runStatus: 'running' | 'awaiting_input' = 'running';
  let requiredAction: RequiredAction | null = null;
  if (batch.requiredAction) {
    runStatus = 'awaiting_input';
    requiredAction = batch.requiredAction;
  }

  const lastNodeId = activeNodeIds[activeNodeIds.length - 1];
  await writeRunCheckpoint({ runRecord, nodeId: lastNodeId, state, artifacts });

  const pause = await readPauseAtCheckpoint({
    runRecord,
    runStatus,
    scheduledWait: batch.scheduledWait,
    nextRound: batch.nextRound,
  });

  // An awaiting_input pause (or a scheduled wait) stops this loop: no further
  // nodes activate this round. The wait is handled by the caller (persisted for
  // the scheduler, or slept through inline in synchronous mode).
  const stop = runStatus === 'awaiting_input' || batch.scheduledWait !== null;
  const nextActiveNodeIds = stop ? [] : batch.nextRound;
  return {
    nextActiveNodeIds,
    runStatus,
    requiredAction,
    scheduledWait: batch.scheduledWait,
    traceId: batch.traceId,
    pauseReason: pause,
  };
};

export type RunLoopState = {
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  activatedNodes: Set<string>;
  iterationCount: Map<string, number>;
  pollAttempts: Map<string, number>;
  retryAttempts: Map<string, number>;
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
  retryAttempts?: Map<string, number>;
}): RunLoopState => {
  const completedNodes = args.completedNodes ?? new Set<string>();
  const conditionLabels = args.conditionLabels ?? new Map<string, string>();
  const activatedNodes =
    args.activatedNodes ??
    new Set<string>(findStartNodes(args.nodes, args.edges));
  const iterationCount = args.iterationCount ?? new Map<string, number>();
  const pollAttempts = args.pollAttempts ?? new Map<string, number>();
  const retryAttempts = args.retryAttempts ?? new Map<string, number>();
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
    retryAttempts,
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
  /**
   * The frontier and reason to park on when an operator pause stopped the loop,
   * or null when nothing paused it. Carried out rather than persisted here so
   * one place settles a run (#1237).
   */
  pause: { reason: string | null; frontier: string[] } | null;
};

/**
 * The status a settled segment carries. A segment that fell out of the loop
 * still `running` has exhausted its frontier and succeeded — unless it stopped
 * on a scheduled wait or an operator pause, both of which the caller persists
 * as their own resting point.
 */
const settledRunStatus = (args: {
  runStatus: MappedOrchestrationRun['status'];
  scheduledWait: ScheduledWait | null;
  pause: RunLoopResult['pause'];
}): MappedOrchestrationRun['status'] => {
  if (args.runStatus !== 'running') return args.runStatus;
  if (args.scheduledWait || args.pause) return args.runStatus;
  return 'succeeded';
};

/**
 * Runs one segment of a run: executes activated nodes round by round until the
 * graph settles (succeeded), a node pauses it on a human node (awaiting_input),
 * or a node parks it on a scheduled wait (delay/poll → sleeping). Mutates
 * `state`/`artifacts` in place and writes a checkpoint per round; the caller
 * persists the outcome.
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
  retryAttempts?: Map<string, number>;
}): Promise<RunLoopResult> => {
  const { runRecord, nodes, edges, state, artifacts, projectIds } = args;
  const loopState = initRunLoopState(args);
  let { activeNodeIds } = loopState;
  const { completedNodes, conditionLabels, activatedNodes, iterationCount } =
    loopState;
  const { pollAttempts, retryAttempts } = loopState;
  let runStatus: MappedOrchestrationRun['status'] = 'running';
  let runError: object | null = null;
  let requiredAction: RequiredAction | null = null;
  let scheduledWait: ScheduledWait | null = null;
  let pause: RunLoopResult['pause'] = null;
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
        retryAttempts,
      });
      activeNodeIds = batchResult.nextActiveNodeIds;
      runStatus = batchResult.runStatus;
      requiredAction = batchResult.requiredAction;
      scheduledWait = batchResult.scheduledWait;
      traceId = traceId ?? batchResult.traceId;
      // A scheduled wait leaves the run 'running' but must break the loop so the
      // caller can offload the wait to the scheduler.
      if (scheduledWait) break;
      if (batchResult.pauseReason) {
        pause = {
          reason: batchResult.pauseReason.reason,
          frontier: activeNodeIds,
        };
        break;
      }
    }

    runStatus = settledRunStatus({ runStatus, scheduledWait, pause });
    if (runStatus === 'succeeded') {
      await recordSkippedNodeExecutions({ runRecord, nodes });
    }
  } catch (error: unknown) {
    runStatus = 'failed';
    runError = buildRunError(error);
    scheduledWait = null;
    pause = null;
    log('executeRun error %o', runError);
  }

  return { runStatus, requiredAction, runError, scheduledWait, traceId, pause };
};
