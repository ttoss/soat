/* eslint-disable max-lines */
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { DecisionOutput, MappedApproval } from './approvals';
import { emitApproval, registerApprovalResumeHandler } from './approvals';
import { persistGuardrailEvaluations } from './guardrailEvaluationRecord';
import { getOrchestrationQueueDriver } from './orchestration-queue-drivers';
import {
  emitRunLifecycleEvent,
  lifecycleEventForStatus,
} from './orchestrationEvents';
import { findStartNodes, resolveNextNodes } from './orchestrationGraph';
import { newLeaseExpiry } from './orchestrationLease';
import {
  applyStateMapping,
  executeToolNode,
} from './orchestrationNodeExecutors';
import {
  buildRunError,
  recordDelayResumption,
} from './orchestrationNodeRecorder';
import { writeNodeArtifact } from './orchestrationNodesNamespace';
import type { RequiredAction, ScheduledWait } from './orchestrationNodeTypes';
import { recordHumanInputResumption } from './orchestrationPauseRecords';
import { resolveRunGraph } from './orchestrationRunGraph';
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
import {
  buildRunAuthHeader,
  readRunTokenPrincipal,
} from './orchestrationRunToken';
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
import type { RequestPrincipal } from './principals';
import { assertValidToolContextKeys } from './toolContext';

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
  const proposedArgs = args.item.proposed_action?.arguments;
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
 * A loop entry with nothing activated, completed, labelled, or attempted — the
 * base every caller starts from, so the five-field literal is written once.
 */
const emptyLoopEntry = (): LoopEntry => {
  return {
    activatedNodes: new Set<string>(),
    completedNodes: new Set<string>(),
    conditionLabels: new Map<string, string>(),
    pollAttempts: new Map<string, number>(),
    retryAttempts: new Map<string, number>(),
  };
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
  const entry = emptyLoopEntry();
  const completedNodes = new Set<string>(Object.keys(artifacts));
  entry.completedNodes = completedNodes;

  // poll and retry re-execute the same node; they differ only in which attempt
  // counter carries the number.
  if (resume.kind === 'poll' || resume.kind === 'retry') {
    const attempts =
      resume.kind === 'poll' ? entry.pollAttempts : entry.retryAttempts;
    attempts.set(nodeId, resume.attempt);
    entry.activatedNodes = new Set<string>([nodeId]);
    return entry;
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
  entry.activatedNodes = new Set<string>(
    resolveNextNodes({
      completedNodeId: nodeId,
      completedNodes,
      conditionLabels: entry.conditionLabels,
      edges,
    })
  );
  return entry;
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
      policyVersion: spec.policyVersion,
    });
    requiredAction.approvalId = item.id;
    requiredAction.expiresAt =
      item.expires_at instanceof Date
        ? item.expires_at.toISOString()
        : String(item.expires_at);
    // Cross-links the guardrail_evaluation audit rows to the item they filed —
    // deferred from `runToolNodeGate` because the item didn't exist yet then.
    if (spec.guardrailEvaluationRecords?.length) {
      void persistGuardrailEvaluations({
        projectId: runRecord.projectId as number,
        toolId: spec.toolId,
        records: spec.guardrailEvaluationRecords,
        approvalId: item.id,
      });
    }
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

/**
 * The principal to persist on a new run. A nested run (`loop`,
 * `sub_orchestration`) is handed its parent's header rather than a principal,
 * so the identity is read back out of it — otherwise a child that has to be
 * redriven from the queue would have none.
 */
const resolveRunPrincipal = (args: {
  principal?: RequestPrincipal;
  authHeader?: string;
}): { principalKind: string | null; principalId: string | null } => {
  const principal = args.principal ?? readRunTokenPrincipal(args.authHeader);
  return {
    principalKind: principal?.principalType ?? null,
    principalId: principal?.principalId ?? null,
  };
};

/** Writes the run row a `start-orchestration-run` produces. */
const createRunRecord = async (args: {
  orchestration: InstanceType<typeof db.Orchestration>;
  projectId: number;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  input?: Record<string, unknown>;
  toolContext?: Record<string, string>;
  triggerId?: string;
  principal?: RequestPrincipal;
  authHeader?: string;
  wait?: boolean;
}): Promise<InstanceType<typeof db.OrchestrationRun>> => {
  return db.OrchestrationRun.create({
    orchestrationId: args.orchestration.id as number,
    // Pin the run to the graph it starts on (#872). Every later execution of
    // this run resolves its topology through this number, so an
    // `update-orchestration` that lands while the run is queued, sleeping or
    // awaiting input cannot re-shape it.
    orchestrationVersion: args.orchestration.version,
    projectId: args.projectId,
    // Synchronous mode enters `running` immediately (it drives in-process);
    // async mode enters `queued` — the run is enqueued and a worker picks it up.
    status: args.wait ? 'running' : 'queued',
    state: args.state,
    activeNodes: [],
    artifacts: args.artifacts,
    input: args.input ?? null,
    toolContext: args.toolContext ?? null,
    triggerId: args.triggerId ?? null,
    ...resolveRunPrincipal({
      principal: args.principal,
      authHeader: args.authHeader,
    }),
    startedAt: new Date(),
    // In `wait` mode the run is `running` immediately, so acquire a lease so the
    // reaper can reclaim it if this driver crashes before the first checkpoint.
    // A `queued` run holds no lease until a worker claims and drives it.
    leaseExpiresAt: args.wait ? newLeaseExpiry() : null,
  });
};

export const startOrchestrationRun = async (args: {
  orchestrationPublicId: string;
  projectId?: number;
  projectIds?: number[];
  input?: Record<string, unknown>;
  // Caller context forwarded as `X-Soat-Context-*` headers on the tool calls of
  // every agent generation this run — and every child run it spawns — produces.
  // Validated here rather than at generation time only: an async run answers 201
  // long before its first node executes, so a key that could not become a header
  // has to be rejected while the caller is still listening.
  toolContext?: Record<string, string>;
  authHeader?: string;
  wait?: boolean;
  // Public id of the trigger firing that started this run, when launched by a
  // trigger. Persisted on the run and propagated to in-run generations' usage
  // events for in-run trigger attribution.
  triggerId?: string;
  // The principal starting this run, persisted so the background worker can
  // re-establish it later (see `orchestrationRunToken.ts`). When omitted, a run
  // started by another run inherits its parent's identity from `authHeader`,
  // which for `loop` / `sub_orchestration` children is the parent's run token.
  principal?: RequestPrincipal;
  // Invoked with the run's public id as soon as the run row is created, before
  // any (in `wait` mode, blocking) execution begins. Lets a caller persist the
  // run id immediately — e.g. a workflow task recording `active_dispatch.id` so
  // cancellation-on-exit can reach a still-running run (#606).
  onRunCreated?: (args: { orchestrationRunId: string }) => Promise<void> | void;
}): Promise<MappedOrchestrationRun> => {
  log('startOrchestrationRun %o', {
    orchestrationPublicId: args.orchestrationPublicId,
    wait: args.wait,
  });

  assertValidToolContextKeys(args.toolContext);

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

  // Seed the run input under the `input` namespace only, matching the
  // pipeline/formation convention (`{ "var": "input.<name>" }`) so a graph
  // reads run input the same way everywhere in the platform. Earlier releases
  // also spread the input flat across top-level state keys; that alias is
  // removed — read run input via `{ "var": "input.<name>" }`.
  const runInput = (args.input ?? {}) as Record<string, unknown>;
  const state: Record<string, unknown> = { input: runInput };
  const artifacts: Record<string, unknown> = {};

  const runRecord = await createRunRecord({
    orchestration: orch,
    projectId: effectiveProjectId,
    state,
    artifacts,
    input: args.input,
    toolContext: args.toolContext,
    triggerId: args.triggerId,
    principal: args.principal,
    authHeader: args.authHeader,
    wait: args.wait,
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
    await args.onRunCreated({
      orchestrationRunId: runRecord.publicId as string,
    });
  }

  // Synchronous (compatibility) mode: block until the run reaches a terminal or
  // awaiting_input state, sleeping through any delay/poll waits in-process.
  if (args.wait) {
    // Resolved through the pinned version rather than the row just read, so the
    // inline drive and every later background drive of this run are guaranteed
    // to execute the same graph even if an edit lands in between.
    const { nodes, edges } = await resolveRunGraph({
      run: runRecord,
      orchestration: orch,
    });

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
  await getOrchestrationQueueDriver().enqueue({
    orchestrationRunId: runRecord.id as number,
    kind: 'continue',
  });
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
/**
 * The `Authorization` header a background-driven run acts with. A run started
 * from an HTTP request is driven inline with that request's own credential; a
 * queued, woken or redriven one has no request to borrow from, so it re-mints a
 * run-as token from the principal persisted on the run.
 */
const runAuthHeader = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<string | undefined> => {
  return buildRunAuthHeader({
    principalKind: args.run.principalKind ?? null,
    principalId: args.run.principalId ?? null,
    projectId: args.run.projectId as number,
    workPublicId: args.run.publicId as string,
  });
};

/**
 * The single terminal state for a run whose orchestration has been deleted
 * underneath it.
 *
 * Three entry points wrote this failure and each wrote a different field set
 * (#907): `driveQueuedRun` cleared the lease but not the wake, `wakeRun` cleared
 * the wake but not the lease — so the reaper kept seeing an active lease on a
 * terminal run — and only `redriveRun` cleared both. The superset is the correct
 * semantics: a failed run holds neither a lease nor a pending wake.
 */
const failRunOrchestrationGone = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<void> => {
  await args.run.update({
    status: 'failed',
    error: { code: 'ORCHESTRATION_NOT_FOUND', message: 'Orchestration gone' },
    wakeAt: null,
    wakeContext: null,
    leaseExpiresAt: null,
    completedAt: new Date(),
  });
};

/**
 * The prologue every background driver shares: load the run's orchestration,
 * resolve its pinned graph, and clone `state`/`artifacts`.
 *
 * The clone is load-bearing — Sequelize does not reliably detect in-place
 * mutation of a JSONB attribute, so driving against `run.state` directly can
 * cause the final update to skip persisting it.
 *
 * A missing orchestration is handled per `onMissing`. The background drivers
 * fail the run and get `null` back, so they return without driving. The
 * request-driven resume asks to `throw` instead: its caller is an HTTP request,
 * which deserves the error rather than a silently failed run.
 */
const prepareRunDrive = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
  /** Replays the last checkpoint over the cloned state (every path but the queued one). */
  restoreCheckpoint?: boolean;
  onMissing?: 'fail' | 'throw';
}): Promise<{
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
} | null> => {
  const { run } = args;

  const orch = await db.Orchestration.findOne({
    where: { id: run.orchestrationId as number },
  });
  if (!orch) {
    if (args.onMissing === 'throw') {
      throw new DomainError(
        'ORCHESTRATION_NOT_FOUND',
        `Orchestration for run not found.`
      );
    }
    await failRunOrchestrationGone({ run });
    return null;
  }

  const { nodes, edges } = await resolveRunGraph({ run, orchestration: orch });
  const state = { ...((run.state ?? {}) as Record<string, unknown>) };
  const artifacts = { ...((run.artifacts ?? {}) as Record<string, unknown>) };

  if (args.restoreCheckpoint) {
    await restoreRunFromCheckpoint({
      orchestrationRunId: run.id as number,
      state,
      artifacts,
    });
  }

  return { nodes, edges, state, artifacts };
};

export const driveQueuedRun = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<void> => {
  const { run } = args;
  log('driveQueuedRun %o', { orchestrationRunId: run.id });

  const prepared = await prepareRunDrive({ run });
  if (!prepared) return;
  const { nodes, edges, state, artifacts } = prepared;

  await run.update({ status: 'running', leaseExpiresAt: newLeaseExpiry() });

  await driveRunToRest({
    runRecord: run,
    nodes,
    edges,
    state,
    artifacts,
    projectIds: [run.projectId as number],
    traceId: run.traceId ?? null,
    authHeader: await runAuthHeader({ run }),
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
  log('wakeRun %o', { orchestrationRunId: run.id });

  const wakeContext = run.wakeContext as PersistedWakeContext | null;
  if (!wakeContext) {
    log('wakeRun: run %s has no wakeContext, skipping', run.id);
    return;
  }

  const prepared = await prepareRunDrive({ run, restoreCheckpoint: true });
  if (!prepared) return;
  const { nodes, edges, state, artifacts } = prepared;

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
    authHeader: await runAuthHeader({ run }),
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
      orchestrationRunId: run.publicId as string,
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

/**
 * Applies a resumed node's outcome, returning a settled `failed` run when the
 * application throws. A class-C-approved `tool` node re-dispatches its tool here
 * (e.g. an HTTP call that can return a non-2xx); on the normal run path such a
 * throw is caught by the run loop and fails the run, but this code runs inside
 * the approvals resume callback (`resumeRunForApproval` → `notifyResume`), which
 * swallows handler errors — so an unguarded throw would leave the run hung in
 * `awaiting_input` forever with the error lost. Settling as `failed` mirrors the
 * loop's failure handling and surfaces the error on the run record. Returns
 * `null` on success (the caller drives the run forward).
 */
const applyResumeOutcomeOrSettleFailure = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
  resumedNode?: OrchestrationNode;
  humanNodeId?: string;
  humanOutput?: Record<string, unknown>;
  decisionLabel?: string;
  approvedArguments?: Record<string, unknown> | null;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
}): Promise<MappedOrchestrationRun | null> => {
  try {
    await applyResumeNodeOutcome(args);
    return null;
  } catch (error: unknown) {
    log('resumeOrchestrationRunExecution: resume application failed %o', error);
    return settleRun({
      runRecord: args.run,
      runStatus: 'failed',
      requiredAction: null,
      runError: buildRunError(error),
      state: args.state,
      artifacts: args.artifacts,
      nodes: args.nodes,
      edges: args.edges,
      traceId: args.run.traceId ?? null,
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
    orchestrationRunId: run.id,
    humanNodeId,
    decisionLabel,
  });

  // `onMissing: 'throw'` — this path answers an HTTP request, so a deleted
  // orchestration surfaces as an error rather than a silently failed run.
  const prepared = await prepareRunDrive({
    run,
    restoreCheckpoint: true,
    onMissing: 'throw',
  });
  // `prepareRunDrive` only returns null in `fail` mode, which this call is not.
  const { nodes, edges, state, artifacts } = prepared!;

  const resumedNode = humanNodeId
    ? nodes.find((n) => {
        return n.id === humanNodeId;
      })
    : undefined;

  const settledOnFailure = await applyResumeOutcomeOrSettleFailure({
    run,
    resumedNode,
    humanNodeId,
    humanOutput,
    decisionLabel,
    approvedArguments: args.approvedArguments,
    nodes,
    edges,
    state,
    artifacts,
  });
  if (settledOnFailure) return settledOnFailure;

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
    // A resumed run acts as the principal that started it, not as whoever
    // submitted the input or resolved the approval — the graph's remaining
    // nodes are the original run's work.
    authHeader: await runAuthHeader({ run }),
    inlineWaits: true,
    entry: {
      ...emptyLoopEntry(),
      activatedNodes: new Set<string>(startNodeIds),
      completedNodes,
      conditionLabels,
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
    ...emptyLoopEntry(),
    activatedNodes,
    completedNodes,
    conditionLabels,
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
  log('redriveRun %o', { orchestrationRunId: run.id });

  const prepared = await prepareRunDrive({ run, restoreCheckpoint: true });
  if (!prepared) return;
  const { nodes, edges, state, artifacts } = prepared;

  const entry = buildRedriveEntry({ nodes, edges, artifacts });

  await driveRunToRest({
    runRecord: run,
    nodes,
    edges,
    state,
    artifacts,
    projectIds: [run.projectId as number],
    traceId: run.traceId ?? null,
    authHeader: await runAuthHeader({ run }),
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
  if (item.origin !== 'node' || !item.orchestration_run_id || !item.node_id)
    return;

  const run = await db.OrchestrationRun.findOne({
    where: { publicId: item.orchestration_run_id },
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
    ],
  });
  if (!run || run.status !== 'awaiting_input') return;

  const activeNodes = run.activeNodes as string[];
  if (!activeNodes.includes(item.node_id)) return;

  log('resumeRunForApproval %o', {
    orchestrationRunId: run.id,
    nodeId: item.node_id,
    decision: decision.decision,
  });

  await resumeOrchestrationRunExecution({
    run,
    humanNodeId: item.node_id,
    humanOutput: { ...decision },
    decisionLabel: decision.decision,
    approvedArguments: resolveApprovedArguments({ item, decision }),
  });
};

registerApprovalResumeHandler(resumeRunForApproval);
