import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  emitRunLifecycleEvent,
  lifecycleEventForStatus,
} from './orchestrationEvents';
import type { RequiredAction, ScheduledWait } from './orchestrationExecutors';
import { applyOutputMapping, resolveNextNodes } from './orchestrationExecutors';
import { recordDelayResumption } from './orchestrationNodeRecorder';
import type { PersistedResumeContext } from './orchestrationRunHelpers';
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

// ── Drive: run a run to its next resting point (terminal, paused, or wait) ──

type LoopEntry = {
  activatedNodes: Set<string>;
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  pollAttempts: Map<string, number>;
};

const sleep = (ms: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    return setTimeout(resolve, Math.max(ms, 0));
  });
};

/**
 * Builds the loop entry to resume a run that paused on a scheduled wait. For a
 * `delay` the timer has elapsed, so the node is recorded complete and the loop
 * resumes from its successors; for a `poll` the node re-executes at the next
 * attempt.
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

  if (resume.kind === 'poll') {
    pollAttempts.set(nodeId, resume.attempt);
    return {
      activatedNodes: new Set<string>([nodeId]),
      completedNodes,
      conditionLabels,
      pollAttempts,
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
  };
};

/**
 * Settles a run into a terminal or paused state: persists the final record,
 * emits the matching lifecycle webhook event, and returns the mapped run.
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
 *   persisting `resumeAt`/`resumeContext` so the scheduler resumes the run
 *   later. Used for durable, request-detached execution.
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
    traceId,
    authHeader,
    inlineWaits,
  } = args;
  let entry = args.entry;

  for (;;) {
    const { runStatus, requiredAction, runError, scheduledWait } =
      await executeRunLoop({
        runRecord,
        nodes,
        edges,
        state,
        artifacts,
        projectIds,
        traceId,
        authHeader,
        completedNodes: entry?.completedNodes,
        conditionLabels: entry?.conditionLabels,
        activatedNodes: entry?.activatedNodes,
        pollAttempts: entry?.pollAttempts,
      });

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

  const startMapped = await mapRunWithIncludes(runRecord.id as number);
  emitRunLifecycleEvent({
    event: 'started',
    projectId: effectiveProjectId,
    run: startMapped,
  });

  // Synchronous (compatibility) mode: block until the run reaches a terminal or
  // paused state, sleeping through any delay/poll waits in-process.
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
 * Resumes a run that a worker/scheduler has determined is due (its `resumeAt`
 * has elapsed). Reads `resumeContext` to rebuild the loop entry, then drives in
 * background mode so a poll that is still not satisfied simply re-schedules.
 */
export const resumeScheduledRun = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<void> => {
  const { run } = args;
  log('resumeScheduledRun %o', { runId: run.id });

  const resumeContext = run.resumeContext as PersistedResumeContext | null;
  if (!resumeContext) {
    log('resumeScheduledRun: run %s has no resumeContext, skipping', run.id);
    return;
  }

  const orch = await db.Orchestration.findOne({
    where: { id: run.orchestrationId as number },
  });
  if (!orch) {
    await run.update({
      status: 'failed',
      error: { code: 'ORCHESTRATION_NOT_FOUND', message: 'Orchestration gone' },
      resumeAt: null,
      resumeContext: null,
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
    nodeId: resumeContext.nodeId,
    resume: resumeContext.resume,
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
  // Clone so mutations produce a fresh reference (see resumeScheduledRun).
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

  // Human-input and manual resume are request-driven, so they block inline
  // (matching their existing synchronous behaviour); timer-driven resumptions
  // go through resumeScheduledRun instead.
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
    },
  });
};
