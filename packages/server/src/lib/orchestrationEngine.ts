/* eslint-disable max-lines */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  emitRunLifecycleEvent,
  lifecycleEventForStatus,
} from './orchestrationEvents';
import type { RequiredAction, ScheduledWait } from './orchestrationExecutors';
import {
  applyOutputMapping,
  findStartNodes,
  resolveNextNodes,
} from './orchestrationExecutors';
import { newLeaseExpiry } from './orchestrationLease';
import {
  recordDelayResumption,
  recordHumanInputResumption,
} from './orchestrationNodeRecorder';
import type { PersistedWakeContext } from './orchestrationRunHelpers';
import {
  applyHumanInputToState,
  getTerminalOutput,
  mapRunWithIncludes,
  persistScheduledWait,
  resolveResumeStartNodes,
  restoreRunFromCheckpoint,
  updateRunRecord,
} from './orchestrationRunHelpers';
import { executeRunLoop } from './orchestrationRunLoop';
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

// ── Drive: run a run to its next resting point (terminal, awaiting_input, or sleeping) ──

type LoopEntry = {
  activatedNodes: Set<string>;
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  pollAttempts: Map<string, number>;
  retryAttempts: Map<string, number>;
};

const sleep = (ms: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    return setTimeout(resolve, Math.max(ms, 0));
  });
};

/**
 * Builds the loop entry to wake a run that was sleeping on a scheduled wait. For
 * a `delay` the timer has elapsed, so the node is recorded complete and the loop
 * resumes from its successors; for a `poll` or `retry` the same node re-executes
 * at the next attempt.
 */
const buildResumeEntry = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodeId: string;
  resume: ScheduledWait['resume'];
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
}): Promise<LoopEntry> => {
  const { runRecord, nodeId, resume, nodes, edges, state, artifacts } = args;
  const completedNodes = new Set<string>(Object.keys(artifacts));
  const conditionLabels = new Map<string, string>();
  const pollAttempts = new Map<string, number>();
  const retryAttempts = new Map<string, number>();

  if (resume.kind === 'poll') {
    pollAttempts.set(nodeId, resume.attempt);
    return {
      activatedNodes: new Set<string>([nodeId]),
      completedNodes,
      conditionLabels,
      pollAttempts,
      retryAttempts,
    };
  }

  if (resume.kind === 'retry') {
    retryAttempts.set(nodeId, resume.attempt);
    return {
      activatedNodes: new Set<string>([nodeId]),
      completedNodes,
      conditionLabels,
      pollAttempts,
      retryAttempts,
    };
  }

  // delay: record completion, apply its artifact, resume from successors.
  const node = nodes.find((n) => {
    return n.id === nodeId;
  });
  artifacts[nodeId] = resume.artifact;
  if (node) applyOutputMapping(node.outputMapping, resume.artifact, state);
  completedNodes.add(nodeId);
  if (node) {
    await recordDelayResumption({
      runRecord,
      node,
      state,
      artifact: resume.artifact,
    });
  }
  const startNodes = resolveNextNodes({
    completedNodeId: nodeId,
    completedNodes,
    conditionLabels,
    edges,
  });
  return {
    activatedNodes: new Set<string>(startNodes),
    completedNodes,
    conditionLabels,
    pollAttempts,
    retryAttempts,
  };
};

/**
 * Settles a run into a terminal or awaiting_input state: persists the final record
 * (including the run's resolved trace id), emits the matching lifecycle webhook
 * event, and returns the mapped run.
 */
const settleRun = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  runStatus: MappedOrchestrationRun['status'];
  requiredAction: RequiredAction | null;
  runError: object | null;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  traceId: string | null;
}): Promise<MappedOrchestrationRun> => {
  const {
    runRecord,
    runStatus,
    requiredAction,
    runError,
    state,
    artifacts,
    nodes,
    edges,
    traceId,
  } = args;

  const output = getTerminalOutput({ nodes, edges, artifacts });
  await updateRunRecord({
    runRecord,
    runStatus,
    requiredAction,
    runError,
    state,
    artifacts,
    output,
    traceId,
  });

  const mapped = await mapRunWithIncludes(runRecord.id as number);

  const event = lifecycleEventForStatus(runStatus);
  if (event) {
    emitRunLifecycleEvent({
      event,
      projectId: runRecord.projectId as number,
      run: mapped,
    });
  }

  return attachRequiredActionToRun({ mapped, runStatus, requiredAction });
};

/**
 * Runs a run forward until it reaches a resting point.
 *
 * - `inlineWaits: true` (synchronous mode) drives the run to completion or a
 *   pause, sleeping through delay/poll waits in-process. Used by callers that
 *   opt into blocking (`wait: true`) and by nested loop/sub-orchestration runs.
 * - `inlineWaits: false` (background mode) stops at the first scheduled wait,
 *   parking the run as `sleeping` with `wakeAt`/`wakeContext` so the scheduler
 *   wakes it later. Used for durable, request-detached execution.
 *
 * The first trace id produced by a traced node (e.g. an `agent` node) is
 * captured across segments and persisted onto the run when it settles.
 */
const driveRunToRest = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  inlineWaits: boolean;
  entry?: LoopEntry;
}): Promise<MappedOrchestrationRun> => {
  const {
    runRecord,
    nodes,
    edges,
    state,
    artifacts,
    projectIds,
    authHeader,
    inlineWaits,
  } = args;
  let entry = args.entry;
  let capturedTraceId: string | null = args.traceId;

  for (;;) {
    const { runStatus, requiredAction, runError, scheduledWait, traceId } =
      await executeRunLoop({
        runRecord,
        nodes,
        edges,
        state,
        artifacts,
        projectIds,
        traceId: capturedTraceId,
        authHeader,
        completedNodes: entry?.completedNodes,
        conditionLabels: entry?.conditionLabels,
        activatedNodes: entry?.activatedNodes,
        pollAttempts: entry?.pollAttempts,
        retryAttempts: entry?.retryAttempts,
      });
    capturedTraceId = capturedTraceId ?? traceId;

    if (scheduledWait) {
      if (inlineWaits) {
        await sleep(scheduledWait.resumeInMs);
        entry = await buildResumeEntry({
          runRecord,
          nodeId: scheduledWait.nodeId,
          resume: scheduledWait.resume,
          nodes,
          edges,
          state,
          artifacts,
        });
        continue;
      }
      await persistScheduledWait({
        runRecord,
        scheduledWait,
        state,
        artifacts,
        now: Date.now(),
      });
      return mapRunWithIncludes(runRecord.id as number);
    }

    return settleRun({
      runRecord,
      runStatus,
      requiredAction,
      runError,
      state,
      artifacts,
      nodes,
      edges,
      traceId: capturedTraceId,
    });
  }
};

export const startOrchestrationRun = async (args: {
  orchestrationPublicId: string;
  projectId?: number;
  projectIds?: number[];
  input?: Record<string, unknown>;
  authHeader?: string;
  wait?: boolean;
}): Promise<MappedOrchestrationRun> => {
  log('startOrchestrationRun %o', {
    orchestrationPublicId: args.orchestrationPublicId,
    wait: args.wait,
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
  // Seed the run input both flat (top-level keys, the original behavior) and
  // under an `input` namespace. The namespace matches the pipeline/formation
  // convention (`{ "var": "input.<name>" }`) so a graph authored against that
  // documented contract sees its run input in every node expression and
  // input_mapping, not just in the persisted final-state dump. Keeping the flat
  // keys preserves existing `{ "var": "<name>" }` references.
  const runInput = (args.input ?? {}) as Record<string, unknown>;
  const state: Record<string, unknown> = { ...runInput, input: runInput };
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
    // The run enters `running` immediately; acquire a lease so the reaper can
    // reclaim it if this driver crashes before the first checkpoint refresh.
    leaseExpiresAt: newLeaseExpiry(),
  });

  const startMapped = await mapRunWithIncludes(runRecord.id as number);
  emitRunLifecycleEvent({
    event: 'started',
    projectId: effectiveProjectId,
    run: startMapped,
  });

  // Synchronous (compatibility) mode: block until the run reaches a terminal or
  // awaiting_input state, sleeping through any delay/poll waits in-process.
  if (args.wait) {
    return driveRunToRest({
      runRecord,
      nodes,
      edges,
      state,
      artifacts,
      projectIds: effectiveProjectIds,
      traceId: runRecord.traceId ?? null,
      authHeader: args.authHeader,
      inlineWaits: true,
    });
  }

  // Durable async mode (default): detach execution from the request. The run is
  // driven in the background and offloads long waits to the scheduler, so this
  // returns immediately with status 'running'.
  void driveRunToRest({
    runRecord,
    nodes,
    edges,
    state,
    artifacts,
    projectIds: effectiveProjectIds,
    traceId: runRecord.traceId ?? null,
    authHeader: args.authHeader,
    inlineWaits: false,
  }).catch((error: unknown) => {
    log('startOrchestrationRun: background drive error %o', error);
  });

  return startMapped;
};

/**
 * Wakes a sleeping run that the scheduler has determined is due (its `wakeAt`
 * has elapsed). Reads `wakeContext` to rebuild the loop entry, then drives in
 * background mode so a poll that is still not satisfied simply re-sleeps.
 */
export const wakeRun = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<void> => {
  const { run } = args;
  log('wakeRun %o', { runId: run.id });

  const wakeContext = run.wakeContext as PersistedWakeContext | null;
  if (!wakeContext) {
    log('wakeRun: run %s has no wakeContext, skipping', run.id);
    return;
  }

  const orch = await db.Orchestration.findOne({
    where: { id: run.orchestrationId as number },
  });
  if (!orch) {
    await run.update({
      status: 'failed',
      error: { code: 'ORCHESTRATION_NOT_FOUND', message: 'Orchestration gone' },
      wakeAt: null,
      wakeContext: null,
      completedAt: new Date(),
    });
    return;
  }

  const nodes = orch.nodes as OrchestrationNode[];
  const edges = orch.edges as OrchestrationEdge[];
  // Clone so mutations produce a fresh object reference — Sequelize does not
  // reliably detect in-place mutation of a JSONB attribute, so reusing
  // run.state directly can cause the final update to skip persisting it.
  const state = { ...((run.state ?? {}) as Record<string, unknown>) };
  const artifacts = { ...((run.artifacts ?? {}) as Record<string, unknown>) };
  await restoreRunFromCheckpoint({ runId: run.id as number, state, artifacts });

  const entry = await buildResumeEntry({
    runRecord: run,
    nodeId: wakeContext.nodeId,
    resume: wakeContext.resume,
    nodes,
    edges,
    state,
    artifacts,
  });

  await driveRunToRest({
    runRecord: run,
    nodes,
    edges,
    state,
    artifacts,
    projectIds: [run.projectId as number],
    traceId: run.traceId ?? null,
    inlineWaits: false,
    entry,
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
  // Clone so mutations produce a fresh reference (see wakeRun).
  const state = { ...((run.state ?? {}) as Record<string, unknown>) };
  const artifacts = { ...((run.artifacts ?? {}) as Record<string, unknown>) };

  await restoreRunFromCheckpoint({ runId: run.id as number, state, artifacts });

  if (humanNodeId && humanOutput) {
    applyHumanInputToState({
      humanNodeId,
      humanOutput,
      nodes,
      state,
      artifacts,
    });
    await recordHumanInputResumption({
      runRecord: run,
      humanNodeId,
      humanOutput,
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

  await run.update({
    status: 'running',
    activeNodes: startNodeIds,
    leaseExpiresAt: newLeaseExpiry(),
  });

  // Human-input and manual resume are request-driven, so they block inline
  // (matching their existing synchronous behaviour); timer-driven resumptions
  // go through wakeRun instead.
  return driveRunToRest({
    runRecord: run,
    nodes,
    edges,
    state,
    artifacts,
    projectIds: [run.projectId as number],
    traceId: run.traceId ?? null,
    inlineWaits: true,
    entry: {
      activatedNodes: new Set<string>(startNodeIds),
      completedNodes,
      conditionLabels,
      pollAttempts: new Map<string, number>(),
      retryAttempts: new Map<string, number>(),
    },
  });
};

/**
 * Reconstructs the loop entry for re-driving a run that crashed while `running`.
 * The last checkpoint's artifacts identify the completed nodes; the frontier to
 * resume is the union of their not-yet-completed successors and any start node
 * that never completed (covering a crash on a parallel start branch that was
 * never checkpointed). Condition-branch labels are not persisted across a crash,
 * mirroring the existing wake/resume paths.
 */
export const buildRedriveEntry = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  artifacts: Record<string, unknown>;
}): LoopEntry => {
  const { nodes, edges, artifacts } = args;
  const completedNodes = new Set<string>(Object.keys(artifacts));
  const conditionLabels = new Map<string, string>();
  const activatedNodes = new Set<string>();

  for (const completedNodeId of completedNodes) {
    const next = resolveNextNodes({
      completedNodeId,
      completedNodes,
      conditionLabels,
      edges,
    });
    for (const n of next) {
      if (!completedNodes.has(n)) activatedNodes.add(n);
    }
  }

  for (const startNode of findStartNodes(nodes, edges)) {
    if (!completedNodes.has(startNode)) activatedNodes.add(startNode);
  }

  return {
    activatedNodes,
    completedNodes,
    conditionLabels,
    pollAttempts: new Map<string, number>(),
    retryAttempts: new Map<string, number>(),
  };
};

/**
 * Re-drives a run the reaper reclaimed after its lease expired — its driver
 * crashed or was redeployed mid-execution. Restores the last checkpoint and
 * resumes the frontier in background mode, so any remaining delay/poll waits are
 * offloaded to the scheduler again rather than slept through in-process.
 */
export const redriveRun = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<void> => {
  const { run } = args;
  log('redriveRun %o', { runId: run.id });

  const orch = await db.Orchestration.findOne({
    where: { id: run.orchestrationId as number },
  });
  if (!orch) {
    await run.update({
      status: 'failed',
      error: { code: 'ORCHESTRATION_NOT_FOUND', message: 'Orchestration gone' },
      wakeAt: null,
      wakeContext: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
    });
    return;
  }

  const nodes = orch.nodes as OrchestrationNode[];
  const edges = orch.edges as OrchestrationEdge[];
  // Clone so mutations produce a fresh reference (see wakeRun).
  const state = { ...((run.state ?? {}) as Record<string, unknown>) };
  const artifacts = { ...((run.artifacts ?? {}) as Record<string, unknown>) };
  await restoreRunFromCheckpoint({ runId: run.id as number, state, artifacts });

  const entry = buildRedriveEntry({ nodes, edges, artifacts });

  await driveRunToRest({
    runRecord: run,
    nodes,
    edges,
    state,
    artifacts,
    projectIds: [run.projectId as number],
    traceId: run.traceId ?? null,
    inlineWaits: false,
    entry,
  });
};
