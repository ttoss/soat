import { db } from '../db';
import { DomainError } from '../errors';
import type { GenerationResult } from './agentGenerationHelpers';
import { createGeneration } from './agents';
import type { GenerationInputMessage } from './generationInputMessages';
import { startOrchestrationRun } from './orchestrationEngine';
import { mapRunWithIncludes } from './orchestrationRunHelpers';
import { buildRunAuthHeader } from './orchestrationRunToken';
import type { MappedOrchestrationRun } from './orchestrations';
import type { RequestPrincipal } from './principals';
import type { WorkflowDispatch } from './workflowsValidation';

// Terminal statuses a settled orchestration run can end in. Unlike a failed
// agent generation (which throws), a failed/cancelled/expired orchestration
// run resolves normally with its partial state — so runDispatch must check
// for these explicitly rather than relying on a rejected promise, or a
// failed dispatch would look identical to a successful one to its caller.
const NON_SUCCESS_TERMINAL_STATUSES: ReadonlySet<
  MappedOrchestrationRun['status']
> = new Set(['failed', 'cancelled', 'expired']);

// A run has reached a resting point once it leaves these — `queued`/`running`
// are transient, `sleeping` is a durable, scheduler-owned wait (#855).
const IN_FLIGHT_STATUSES: ReadonlySet<MappedOrchestrationRun['status']> =
  new Set(['queued', 'running', 'sleeping']);

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
      !IN_FLIGHT_STATUSES.has(row.status as MappedOrchestrationRun['status'])
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
    stream: false,
  })) as GenerationResult;

  return {
    result: gen.output ?? {},
    generationId: gen.id,
    orchestrationRunId: null,
  };
};

// Runs one dispatch and returns its exposed `{result}` and provenance ids. A
// generation exposes its output; an orchestration run exposes its final state
// (matching sub-orchestration semantics, PRD D2).
export const runDispatch = async (args: {
  dispatch: WorkflowDispatch;
  projectId: number;
  taskPublicId: string;
  inputs: Record<string, unknown>;
  // The identity the dispatch runs as, for both kinds; see `dispatchOnEnter`.
  principal?: RequestPrincipal;
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
    });
  }

  // Started in durable/async mode (`wait` omitted) rather than `wait: true`:
  // a task dispatch must never force the underlying run through the
  // in-process `inlineWaits` path, or a poll/delay node sleeps the whole
  // interval in this process instead of parking `sleeping` for the scheduler
  // to wake (#855). `runDispatch` still resolves once the run settles — only
  // *how* it waits changes, so callers (retry, on_complete/on_failure
  // routing) are unaffected.
  const started = await startOrchestrationRun({
    orchestrationPublicId: args.dispatch.orchestrationId!,
    projectIds: [args.projectId],
    input: args.inputs,
    principal: args.principal,
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
