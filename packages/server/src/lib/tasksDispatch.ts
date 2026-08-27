import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import type { GenerationResult } from './agentGenerationTypes';
import type { GenerationInputMessage } from './generationInputMessages';
import { startOrchestrationRun } from './orchestrationEngine';
import { executeToolNode } from './orchestrationNodeExecutors';
import { mapRunWithIncludes } from './orchestrationRunHelpers';
import { buildRunAuthHeader } from './orchestrationRunToken';
import type { MappedOrchestrationRun } from './orchestrations';
import type { RequestPrincipal } from './principals';
import type { WorkflowDispatch } from './workflowsValidation';

// Unlike a failed generation, a failed/cancelled/expired run resolves normally
// with its partial state, so `runDispatch` must check these explicitly or a
// failed dispatch looks identical to a successful one. Exported so the
// reconciler classifies by this exact set — a second copy could drift and route
// `on_complete` where a live dispatch routed `on_failure`.
export const NON_SUCCESS_TERMINAL_STATUSES: ReadonlySet<
  MappedOrchestrationRun['status']
> = new Set(['failed', 'cancelled', 'expired']);

// `sleeping` is a durable, scheduler-owned wait, not in flight (#855).
// Exported so the reconciler decides "settled" by the same rule as the
// in-process awaiter below.
export const RUN_IN_FLIGHT_STATUSES: ReadonlySet<
  MappedOrchestrationRun['status']
> = new Set(['queued', 'running', 'sleeping']);

const sleep = (ms: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const pollIntervalMs = (): number => {
  const envMs = Number(process.env.ORCHESTRATION_DISPATCH_POLL_INTERVAL_MS);
  return Number.isFinite(envMs) && envMs > 0 ? envMs : 250;
};

/**
 * Awaits a task-dispatched orchestration run's eventual resting point
 * (`succeeded`/`failed`/`cancelled`/`expired`/`awaiting_input`) without ever
 * blocking in-process for the wait itself. The run is started in durable,
 * scheduler-driven mode (`startOrchestrationRun` without `wait`), so a
 * `poll`/`delay` node's actual wait is offloaded to
 * `orchestrationScheduler.ts` exactly like any other orchestration run
 * (`persistScheduledWait` → `sleeping` → the scheduler wakes it) — this loop
 * only checks whether that durable machinery has reached a resting point yet,
 * it never itself holds a `setTimeout` open for the wait's duration (#855).
 */
const waitForOrchestrationRunSettlement = async (args: {
  orchestrationRunId: string;
}): Promise<MappedOrchestrationRun> => {
  for (;;) {
    const row = await db.OrchestrationRun.findOne({
      where: { publicId: args.orchestrationRunId },
      attributes: ['id', 'status'],
    });
    if (!row) {
      throw new DomainError(
        'ORCHESTRATION_RUN_NOT_FOUND',
        `Run '${args.orchestrationRunId}' not found.`
      );
    }
    if (
      !RUN_IN_FLIGHT_STATUSES.has(
        row.status as MappedOrchestrationRun['status']
      )
    ) {
      return mapRunWithIncludes(row.id as number);
    }
    await sleep(pollIntervalMs());
  }
};

export type DispatchResult = {
  result: unknown;
  generationId: string | null;
  orchestrationRunId: string | null;
  /**
   * Set only by a `tool` dispatch, which produces neither a generation nor a
   * run. It is that kind's provenance: every automation move must record a
   * machine-readable cause (#792), and for a tool call the tool is it.
   */
  toolId: string | null;
};

/**
 * Shapes a dispatch `input_mapping` result into agent messages: an explicit
 * `messages` array is passed through, a `prompt` string becomes a single user
 * message, and any other non-empty object is JSON-encoded as one user message.
 */
const buildAgentMessages = (
  inputs: Record<string, unknown>
): GenerationInputMessage[] => {
  if (Array.isArray(inputs.messages)) {
    return inputs.messages as GenerationInputMessage[];
  }
  if (typeof inputs.prompt === 'string' && inputs.prompt.length > 0) {
    return [{ role: 'user', content: inputs.prompt }];
  }
  return [{ role: 'user', content: JSON.stringify(inputs) }];
};

/**
 * Runs an `agent` dispatch and exposes the generation's output.
 *
 * An agent dispatch is as request-less as an orchestration one: nothing awaits
 * it and there is no inbound request to borrow a credential from. So it re-mints
 * the same run-as token, keyed to the task, or the agent's `soat` tools reach
 * the loopback unauthenticated and the model is handed a 401 in place of a tool
 * result (#884). The header is `undefined` when the chain has no principal — a
 * trigger- or OAuth-started task deliberately records none, and the generation
 * then behaves exactly as it did before, self-calls included (see
 * `orchestrationRunToken.ts`).
 */
const runAgentDispatch = async (args: {
  agentId: string;
  projectId: number;
  taskPublicId: string;
  inputs: Record<string, unknown>;
  principal?: RequestPrincipal;
  toolContext?: Record<string, string>;
}): Promise<DispatchResult> => {
  const authHeader = await buildRunAuthHeader({
    principalKind: args.principal?.principalType ?? null,
    principalId: args.principal?.principalId ?? null,
    projectId: args.projectId,
    workPublicId: args.taskPublicId,
  });

  const gen = (await createGeneration({
    agentId: args.agentId,
    projectIds: [args.projectId],
    messages: buildAgentMessages(args.inputs),
    authHeader,
    toolContext: args.toolContext,
    stream: false,
  })) as GenerationResult;

  return {
    result: gen.output ?? {},
    generationId: gen.id,
    orchestrationRunId: null,
    toolId: null,
  };
};

/**
 * Runs a `tool` dispatch: one tool call, settled within the dispatch.
 *
 * Delegates to the orchestration engine's `tool` node executor rather than
 * calling `callTool` directly, so a workflow-dispatched call is adjudicated by
 * exactly the same guardrail gate (class B/C/D) and recorded in the same
 * activity feed as the identical call made from an orchestration graph. Calling
 * `callTool` here instead would have quietly created a second, ungoverned path
 * to every tool in the project.
 *
 * The executor is node-shaped, so the dispatch is expressed as the one-node
 * graph it is. `state` is the task context and `inputMapping` the dispatch's
 * own, mapped by the executor exactly as a graph node's would be.
 *
 * Only an `artifact` outcome is a completed dispatch. A guardrail that blocks
 * the call (class D / tripwire) or routes it to human approval (class C)
 * produces a result a task dispatch has nowhere to put — there is no run to
 * park and resume — so it fails the dispatch, which `on_failure` can route. An
 * approval-gated tool belongs behind an orchestration dispatch, whose engine
 * can park on it.
 */
const runToolDispatch = async (args: {
  toolId: string;
  operationId?: string;
  inputMapping?: Record<string, unknown>;
  taskContext: Record<string, unknown>;
  projectId: number;
  taskPublicId: string;
  principal?: RequestPrincipal;
  // A `tool` dispatch carries the same bag its `agent`/`orchestration` siblings
  // do; without it a tool naming a `{{context:}}` header or preset cannot be
  // dispatched from a workflow at all (#345).
  toolContext?: Record<string, string>;
}): Promise<DispatchResult> => {
  const authHeader = await buildRunAuthHeader({
    principalKind: args.principal?.principalType ?? null,
    principalId: args.principal?.principalId ?? null,
    projectId: args.projectId,
    workPublicId: args.taskPublicId,
  });

  const outcome = await executeToolNode({
    node: {
      // Names the dispatching task, so a guardrail reading the node id and an
      // activity entry both point back at what actually made the call.
      id: `task:${args.taskPublicId}`,
      type: 'tool',
      toolId: args.toolId,
      operationId: args.operationId,
      inputMapping: args.inputMapping,
    },
    state: args.taskContext,
    projectIds: [args.projectId],
    projectId: args.projectId,
    authHeader,
    toolContext: args.toolContext,
  });

  if (outcome.kind !== 'artifact') {
    throw new DomainError(
      'TOOL_DISPATCH_FAILED',
      `Tool dispatch did not complete: the call was settled as '${outcome.kind}' before returning a result.`,
      { tool_id: args.toolId, outcome: outcome.kind }
    );
  }

  return {
    result: outcome.artifact,
    generationId: null,
    orchestrationRunId: null,
    toolId: args.toolId,
  };
};

// Returns the dispatch's exposed `{result}` and provenance ids: a generation's
// output, a run's final state (matching sub-orchestration semantics), or a tool
// call's return value.
export const runDispatch = async (args: {
  dispatch: WorkflowDispatch;
  projectId: number;
  taskPublicId: string;
  inputs: Record<string, unknown>;
  /**
   * The `{task}` JSON Logic context the dispatch's `input_mapping` was resolved
   * against. `inputs` is that resolution and is what the agent and orchestration
   * kinds consume; a `tool` dispatch needs the unresolved pair instead, because
   * its executor owns the mapping step (and applying it twice would resolve the
   * already-resolved arguments a second time).
   */
  taskContext: Record<string, unknown>;
  // The identity the dispatch runs as, for every kind; see `dispatchOnEnter`.
  principal?: RequestPrincipal;
  /**
   * The task's caller context, forwarded as `X-Soat-Context-*` headers on the
   * tool calls this dispatch makes (#950). For an orchestration dispatch it is
   * handed to the run, which carries it to every agent node — and to every child
   * run a `loop` or `sub_orchestration` node starts (#945 item 1).
   */
  toolContext?: Record<string, string>;
  // Called as soon as a dispatch id is known but before the (blocking) wait
  // completes. For orchestration dispatches this fires at run creation, so the
  // run id can be persisted while the run is still in flight (#606).
  onDispatchStarted?: (ids: {
    generationId: string | null;
    orchestrationRunId: string | null;
  }) => Promise<void> | void;
}): Promise<DispatchResult> => {
  if (args.dispatch.kind === 'agent') {
    return runAgentDispatch({
      agentId: args.dispatch.agentId!,
      projectId: args.projectId,
      taskPublicId: args.taskPublicId,
      inputs: args.inputs,
      principal: args.principal,
      toolContext: args.toolContext,
    });
  }

  if (args.dispatch.kind === 'tool') {
    return runToolDispatch({
      toolId: args.dispatch.toolId!,
      operationId: args.dispatch.operationId,
      inputMapping: args.dispatch.inputMapping,
      taskContext: args.taskContext,
      projectId: args.projectId,
      taskPublicId: args.taskPublicId,
      principal: args.principal,
      toolContext: args.toolContext,
    });
  }

  // Durable mode, never `wait: true`: the in-process `inlineWaits` path would
  // sleep a poll/delay node's whole interval here instead of parking
  // `sleeping` for the scheduler (#855). `runDispatch` still resolves once the
  // run settles, so callers are unaffected.
  const started = await startOrchestrationRun({
    orchestrationPublicId: args.dispatch.orchestrationId!,
    projectIds: [args.projectId],
    input: args.inputs,
    principal: args.principal,
    toolContext: args.toolContext,
    onRunCreated: args.onDispatchStarted
      ? ({ orchestrationRunId }) => {
          return args.onDispatchStarted!({
            generationId: null,
            orchestrationRunId,
          });
        }
      : undefined,
  });
  const run = await waitForOrchestrationRunSettlement({
    orchestrationRunId: started.id,
  });

  if (NON_SUCCESS_TERMINAL_STATUSES.has(run.status)) {
    const runError =
      run.error && typeof run.error === 'object' && 'message' in run.error
        ? String((run.error as { message?: unknown }).message)
        : `Orchestration run ended with status '${run.status}'`;
    // Meta keys are written snake_case to match failedDispatchIds and the
    // external REST contract, mirroring recordGenerationFailure's
    // generation_id shape for the agent-dispatch failure path.
    throw new DomainError('ORCHESTRATION_DISPATCH_FAILED', runError, {
      orchestration_run_id: run.id,
      run_status: run.status,
    });
  }

  return {
    result: run.state ?? {},
    generationId: null,
    orchestrationRunId: run.id,
    toolId: null,
  };
};

/**
 * Extracts the failed generation/run id a dispatch error carries in its meta.
 * `createGeneration` wraps terminal failures in a `DomainError` whose meta holds
 * the `generation_id` (see `recordGenerationFailure`), written snake_case
 * to match the external REST contract. This lets the
 * on_failure-driven transition link the causing record, mirroring the
 * on_complete path's `id: generationId ?? orchestrationRunId` provenance (#607).
 */
export const failedDispatchIds = (
  error: unknown
): { generationId: string | null; orchestrationRunId: string | null } => {
  const meta = error instanceof DomainError ? (error.meta ?? {}) : {};
  const generationId =
    typeof meta.generation_id === 'string' ? meta.generation_id : null;
  const orchestrationRunId =
    typeof meta.orchestration_run_id === 'string'
      ? meta.orchestration_run_id
      : null;
  return { generationId, orchestrationRunId };
};
