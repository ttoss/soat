import { db } from '../db';
import type { RequiredAction, ScheduledWait } from './orchestrationExecutors';
import { applyStateMapping, resolveNextNodes } from './orchestrationExecutors';
import { writeNodeArtifact } from './orchestrationNodesNamespace';
import type {
  MappedOrchestrationRun,
  OrchestrationEdge,
  OrchestrationNode,
} from './orchestrations';
import { mapOrchestrationRun, nodeExecutionsInclude } from './orchestrations';

export const mapRunWithIncludes = async (
  runId: number
): Promise<MappedOrchestrationRun> => {
  const finalRun = await db.OrchestrationRun.findOne({
    where: { id: runId },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
      nodeExecutionsInclude(),
    ],
  });

  const run = finalRun as InstanceType<typeof db.OrchestrationRun> & {
    orchestration: InstanceType<typeof db.Orchestration>;
    project: InstanceType<typeof db.Project>;
    nodeExecutions?: InstanceType<typeof db.OrchestrationNodeExecution>[];
  };

  return mapOrchestrationRun(run);
};

export const getTerminalOutput = (args: {
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

export const updateRunRecord = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  runStatus: MappedOrchestrationRun['status'];
  requiredAction: RequiredAction | null;
  runError: object | null;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  output: Record<string, unknown>;
  traceId?: string | null;
}): Promise<void> => {
  const {
    runRecord,
    runStatus,
    requiredAction,
    runError,
    state,
    artifacts,
    output,
    traceId,
  } = args;
  const isTerminal = runStatus === 'succeeded' || runStatus === 'failed';
  await runRecord.update({
    status: runStatus,
    state,
    activeNodes:
      runStatus === 'awaiting_input' ? [requiredAction?.nodeId ?? ''] : [],
    artifacts,
    error: runError,
    requiredAction: runStatus === 'awaiting_input' ? requiredAction : null,
    output: runStatus === 'succeeded' ? output : null,
    // Settling into a terminal or awaiting_input state clears any pending
    // scheduled wake so the background scheduler ignores the run, and releases
    // the run lease (no worker holds it any longer) so the reaper ignores it.
    wakeAt: null,
    wakeContext: null,
    leaseExpiresAt: null,
    completedAt: isTerminal ? new Date() : null,
    // Only fill once: the first trace produced by a traced node (e.g. an
    // `agent` node) becomes the run's trace_id and is never overwritten.
    ...(runRecord.traceId ? {} : traceId ? { traceId } : {}),
  });
};

/**
 * Context persisted on a `sleeping` run so the scheduler knows which node to
 * wake and how (a delay carries the artifact to record; a poll carries the next
 * attempt number).
 */
export type PersistedWakeContext = {
  nodeId: string;
  resume: ScheduledWait['resume'];
};

/**
 * Persists a run that has parked on a timer (delay) or a poll interval. The run
 * transitions to `sleeping` — it holds no worker and no memory, pure DB state —
 * and `wakeAt`/`wakeContext` mark it for the background scheduler to wake once
 * the timer elapses. Survives a process restart because the state lives in the
 * database, not an in-process timer.
 */
export const persistScheduledWait = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  scheduledWait: ScheduledWait;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  now: number;
}): Promise<void> => {
  const { runRecord, scheduledWait, state, artifacts, now } = args;
  const wakeContext: PersistedWakeContext = {
    nodeId: scheduledWait.nodeId,
    resume: scheduledWait.resume,
  };
  await runRecord.update({
    status: 'sleeping',
    state,
    artifacts,
    activeNodes: [scheduledWait.nodeId],
    requiredAction: null,
    error: null,
    output: null,
    completedAt: null,
    wakeAt: new Date(now + scheduledWait.resumeInMs),
    wakeContext,
    // A `sleeping` run holds no worker, so it releases its lease; the scheduler
    // (not the reaper) is responsible for waking it at `wakeAt`.
    leaseExpiresAt: null,
  });
};

export const restoreRunFromCheckpoint = async (args: {
  runId: number;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
}): Promise<void> => {
  const checkpoint = await db.OrchestrationCheckpoint.findOne({
    where: { runId: args.runId },
    order: [['createdAt', 'DESC']],
  });
  if (checkpoint) {
    Object.assign(args.state, checkpoint.state as Record<string, unknown>);
    Object.assign(
      args.artifacts,
      checkpoint.artifacts as Record<string, unknown>
    );
  }
};

export const applyHumanInputToState = (args: {
  humanNodeId: string;
  humanOutput: Record<string, unknown>;
  nodes: OrchestrationNode[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
}): void => {
  const { humanNodeId, humanOutput, nodes, state, artifacts } = args;
  const humanNode = nodes.find((n) => {
    return n.id === humanNodeId;
  });
  writeNodeArtifact({ nodeId: humanNodeId, artifact: humanOutput, state });
  if (humanNode) {
    applyStateMapping(humanNode.stateMapping, humanOutput, state);
  }
  artifacts[humanNodeId] = humanOutput;
};

export const resolveResumeStartNodes = (args: {
  humanNodeId?: string;
  activeNodes: string[];
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  edges: OrchestrationEdge[];
  decisionNodeIds?: Set<string>;
}): string[] => {
  if (args.humanNodeId) {
    return resolveNextNodes({
      completedNodeId: args.humanNodeId,
      completedNodes: args.completedNodes,
      conditionLabels: args.conditionLabels,
      edges: args.edges,
      decisionNodeIds: args.decisionNodeIds,
    });
  }
  return args.activeNodes;
};
