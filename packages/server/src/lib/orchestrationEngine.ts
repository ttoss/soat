/* eslint-disable max-lines */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { DecisionOutput, MappedApproval } from './approvals';
import { emitApproval, registerApprovalResumeHandler } from './approvals';
import {
  emitRunLifecycleEvent,
  lifecycleEventForStatus,
} from './orchestrationEvents';
import type { RequiredAction, ScheduledWait } from './orchestrationExecutors';
import {
  applyStateMapping,
  findStartNodes,
  resolveNextNodes,
} from './orchestrationExecutors';
import { newLeaseExpiry } from './orchestrationLease';
import { executeToolNode } from './orchestrationNodeExecutors';
import {
  recordDelayResumption,
  recordHumanInputResumption,
} from './orchestrationNodeRecorder';
import { writeNodeArtifact } from './orchestrationNodesNamespace';
import { enqueueRunTask } from './orchestrationQueue';
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
import { kickWorker } from './orchestrationWorker';

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

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// The args to re-dispatch an approved tool call with: the human's edit if
// present, otherwise the frozen proposal. Ignored unless the parked node is a
// guardrail-gated tool node approved via class-C.
const resolveApprovedArguments = (args: {
  item: MappedApproval;
  decision: DecisionOutput;
}): Record<string, unknown> | null => {
  if (isPlainRecord(args.decision.editedArgs)) return args.decision.editedArgs;
  const proposedArgs = args.item.proposedAction?.arguments;
  return isPlainRecord(proposedArgs) ? proposedArgs : null;
};

/** Ids of the graph's `approval` nodes — the decision-routed nodes whose
 * unlabeled edges follow only on approval (see resolveNextNodes). */
const collectApprovalNodeIds = (nodes: OrchestrationNode[]): Set<string> => {
  return new Set(
    nodes
      .filter((n) => {
        return n.type === 'approval';
      })
      .map((n) => {
        return n.id;
      })
  );
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
  writeNodeArtifact({ nodeId, artifact: resume.artifact, state });
  if (node) applyStateMapping(node.stateMapping, resume.artifact, state);
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

  // When the run parks on an `approval` node, emit the ApprovalItem now (the run
  // record is in scope here) and stamp the created item's id/expiry back onto the
  // persisted required_action. The bulky frozen spec is dropped after emit — the
  // ApprovalItem is its durable home.
  if (
    runStatus === 'awaiting_input' &&
    requiredAction?.type === 'approval' &&
    requiredAction.approvalSpec &&
    !requiredAction.approvalId
  ) {
    const spec = requiredAction.approvalSpec;
    const item = await emitApproval({
      projectId: runRecord.projectId as number,
      origin: 'node',
      proposedAction: { toolId: spec.toolId, arguments: spec.arguments },
      reasoning: spec.reasoning,
      evidence: spec.evidence,
      predictedImpact: spec.predictedImpact,
      expiresInSeconds: spec.expiresInSeconds,
      orchestrationRunId: runRecord.id as number,
      nodeId: requiredAction.nodeId,
    });
    requiredAction.approvalId = item.id;
    requiredAction.expiresAt =
      item.expiresAt instanceof Date
        ? item.expiresAt.toISOString()
        : String(item.expiresAt);
    requiredAction.approvalSpec = undefined;
  }

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
  // Public id of the trigger firing that started this run, when launched by a
  // trigger. Persisted on the run and propagated to in-run generations' usage
  // events for in-run trigger attribution.
  triggerId?: string;
  // Invoked with the run's public id as soon as the run row is created, before
  // any (in `wait` mode, blocking) execution begins. Lets a caller persist the
  // run id immediately — e.g. a workflow task recording `active_dispatch.id` so
  // cancellation-on-exit can reach a still-running run (#606).
  onRunCreated?: (args: { runId: string }) => Promise<void> | void;
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
  // Seed the run input under the `input` namespace only, matching the
  // pipeline/formation convention (`{ "var": "input.<name>" }`) so a graph
  // reads run input the same way everywhere in the platform. Earlier releases
  // also spread the input flat across top-level state keys; that alias is
  // removed — read run input via `{ "var": "input.<name>" }`.
  const runInput = (args.input ?? {}) as Record<string, unknown>;
  const state: Record<string, unknown> = { input: runInput };
  const artifacts: Record<string, unknown> = {};

  const runRecord = await db.OrchestrationRun.create({
    orchestrationId: orch.id as number,
    projectId: effectiveProjectId,
    // Synchronous mode enters `running` immediately (it drives in-process);
    // async mode enters `queued` — the run is enqueued and a worker picks it up.
    status: args.wait ? 'running' : 'queued',
    state,
    activeNodes: [],
    artifacts,
    input: args.input ?? null,
    triggerId: args.triggerId ?? null,
    startedAt: new Date(),
    // In `wait` mode the run is `running` immediately, so acquire a lease so the
    // reaper can reclaim it if this driver crashes before the first checkpoint.
    // A `queued` run holds no lease until a worker claims and drives it.
    leaseExpiresAt: args.wait ? newLeaseExpiry() : null,
  });

  const startMapped = await mapRunWithIncludes(runRecord.id as number);
  emitRunLifecycleEvent({
    event: 'started',
    projectId: effectiveProjectId,
    run: startMapped,
  });

  // Surface the run id before any (blocking, in `wait` mode) execution begins,
  // so a caller can record it while the run is still in flight (#606).
  if (args.onRunCreated) {
    await args.onRunCreated({ runId: runRecord.publicId as string });
  }

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

  // Durable async mode (default): enqueue a `continue` task and return
  // immediately with status 'queued'. No node executes inside this HTTP request;
  // a worker claims the task and drives the run. `kickWorker` lets a
  // single-process deployment (the API process is itself a valid worker) start
  // draining right away without a separate worker process.
  await enqueueRunTask({ runId: runRecord.id as number, kind: 'continue' });
  kickWorker();

  return startMapped;
};

/**
 * Drives a freshly `queued` run for the first time: loads its orchestration,
 * transitions it to `running` under a fresh lease, and drives it in background
 * mode (long waits offloaded to the scheduler) from its start nodes. Called by
 * the worker for a `continue` task whose run is still `queued`. A run whose
 * orchestration has since been deleted is settled `failed`.
 */
export const driveQueuedRun = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<void> => {
  const { run } = args;
  log('driveQueuedRun %o', { runId: run.id });

  const orch = await db.Orchestration.findOne({
    where: { id: run.orchestrationId as number },
  });
  if (!orch) {
    await run.update({
      status: 'failed',
      error: { code: 'ORCHESTRATION_NOT_FOUND', message: 'Orchestration gone' },
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

  await run.update({ status: 'running', leaseExpiresAt: newLeaseExpiry() });

  await driveRunToRest({
    runRecord: run,
    nodes,
    edges,
    state,
    artifacts,
    projectIds: [run.projectId as number],
    traceId: run.traceId ?? null,
    inlineWaits: false,
  });
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

/**
 * Applies a resumed node's outcome to run state. For a class-C-approved `tool`
 * node it re-dispatches the tool with the frozen/edited args (gate skipped, Q4)
 * and records the tool result as the node artifact so downstream nodes read the
 * tool output; every other resume (human input, or an approval decision on an
 * `approval`/rejected/expired node) records the submitted output as-is.
 */
const applyResumeNodeOutcome = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
  resumedNode?: OrchestrationNode;
  humanNodeId?: string;
  humanOutput?: Record<string, unknown>;
  decisionLabel?: string;
  approvedArguments?: Record<string, unknown> | null;
  nodes: OrchestrationNode[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
}): Promise<void> => {
  const { run, resumedNode, humanNodeId, humanOutput, decisionLabel } = args;

  if (resumedNode?.type === 'tool' && decisionLabel === 'approved') {
    const execResult = await executeToolNode({
      node: resumedNode,
      state: args.state,
      projectIds: [run.projectId as number],
      projectId: run.projectId as number,
      runId: run.publicId as string,
      approvedArguments: args.approvedArguments ?? {},
    });
    const toolArtifact =
      execResult.kind === 'artifact' ? execResult.artifact : {};
    writeNodeArtifact({
      nodeId: resumedNode.id,
      artifact: toolArtifact,
      state: args.state,
    });
    applyStateMapping(resumedNode.stateMapping, toolArtifact, args.state);
    args.artifacts[resumedNode.id] = toolArtifact;
    await recordHumanInputResumption({
      runRecord: run,
      humanNodeId: resumedNode.id,
      humanOutput: toolArtifact,
    });
    return;
  }

  if (humanNodeId && humanOutput) {
    applyHumanInputToState({
      humanNodeId,
      humanOutput,
      nodes: args.nodes,
      state: args.state,
      artifacts: args.artifacts,
    });
    await recordHumanInputResumption({
      runRecord: run,
      humanNodeId,
      humanOutput,
    });
  }
};

// Decision-routed node ids for a resume: the graph's `approval` nodes, plus a
// gated `tool` node that parked for approval — its unlabeled success edge
// follows only on `approved`, so a rejected/expired decision never falls
// through to the happy path.
const buildResumeDecisionNodeIds = (args: {
  nodes: OrchestrationNode[];
  resumedNode?: OrchestrationNode;
  humanNodeId?: string;
}): Set<string> => {
  const ids = collectApprovalNodeIds(args.nodes);
  if (args.resumedNode?.type === 'tool' && args.humanNodeId) {
    ids.add(args.humanNodeId);
  }
  return ids;
};

// Builds the resume activation set: which nodes are already complete, the
// resumed node's branch label, and the successor node ids to activate next.
const resolveResumeActivation = (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  artifacts: Record<string, unknown>;
  resumedNode?: OrchestrationNode;
  humanNodeId?: string;
  decisionLabel?: string;
}): {
  completedNodes: Set<string>;
  conditionLabels: Map<string, string>;
  startNodeIds: string[];
} => {
  const activeNodes = args.run.activeNodes as string[];
  const completedNodes = new Set<string>(
    Object.keys(args.artifacts).concat(
      args.humanNodeId ? [args.humanNodeId] : []
    )
  );
  const conditionLabels = new Map<string, string>();
  // An approval resume routes by its decision: seed the resumed node's branch
  // label so `resolveNextNodes` matches `on_expired`/`approved`/`rejected` edges
  // and gates unlabeled edges to the approval case only.
  if (args.humanNodeId && args.decisionLabel) {
    conditionLabels.set(args.humanNodeId, args.decisionLabel);
  }
  const startNodeIds = resolveResumeStartNodes({
    humanNodeId: args.humanNodeId,
    activeNodes,
    completedNodes,
    conditionLabels,
    edges: args.edges,
    decisionNodeIds: buildResumeDecisionNodeIds({
      nodes: args.nodes,
      resumedNode: args.resumedNode,
      humanNodeId: args.humanNodeId,
    }),
  });
  return { completedNodes, conditionLabels, startNodeIds };
};

export const resumeOrchestrationRunExecution = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
  humanNodeId?: string;
  humanOutput?: Record<string, unknown>;
  // Set when resuming an `approval` node: the decision ('approved' | 'rejected'
  // | 'expired') becomes the node's branch label so `on_expired`/`approved`/…
  // edges route, and unlabeled edges follow only on approval.
  decisionLabel?: string;
  // Set when resuming a guardrail-gated `tool` node approved via class-C: the
  // frozen (or edited) arguments to re-dispatch the tool with, gate skipped.
  approvedArguments?: Record<string, unknown> | null;
}): Promise<MappedOrchestrationRun> => {
  const { run, humanNodeId, humanOutput, decisionLabel } = args;
  log('resumeOrchestrationRunExecution %o', {
    runId: run.id,
    humanNodeId,
    decisionLabel,
  });

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

  const resumedNode = humanNodeId
    ? nodes.find((n) => {
        return n.id === humanNodeId;
      })
    : undefined;

  await applyResumeNodeOutcome({
    run,
    resumedNode,
    humanNodeId,
    humanOutput,
    decisionLabel,
    approvedArguments: args.approvedArguments,
    nodes,
    state,
    artifacts,
  });

  const { completedNodes, conditionLabels, startNodeIds } =
    resolveResumeActivation({
      run,
      nodes,
      edges,
      artifacts,
      resumedNode,
      humanNodeId,
      decisionLabel,
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

/**
 * Resumes an orchestration run parked on an `approval` node once its item is
 * resolved (approved/rejected/expired). Registered as the approvals module's
 * `node`-origin resumption callback (§1 of the PRD) so the approvals module
 * never imports the engine — the dependency points one way (engine → approvals).
 * A no-op when the item did not come from an orchestration run, the run is no
 * longer awaiting this node, or the run has moved on.
 */
const resumeRunForApproval = async (args: {
  item: MappedApproval;
  decision: DecisionOutput;
}): Promise<void> => {
  const { item, decision } = args;
  if (item.origin !== 'node' || !item.runId || !item.nodeId) return;

  const run = await db.OrchestrationRun.findOne({
    where: { publicId: item.runId },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
    ],
  });
  if (!run || run.status !== 'awaiting_input') return;

  const activeNodes = run.activeNodes as string[];
  if (!activeNodes.includes(item.nodeId)) return;

  log('resumeRunForApproval %o', {
    runId: run.id,
    nodeId: item.nodeId,
    decision: decision.decision,
  });

  await resumeOrchestrationRunExecution({
    run,
    humanNodeId: item.nodeId,
    humanOutput: { ...decision },
    decisionLabel: decision.decision,
    approvedArguments: resolveApprovedArguments({ item, decision }),
  });
};

registerApprovalResumeHandler(resumeRunForApproval);
