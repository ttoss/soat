import createDebug from 'debug';

import type { RequestPrincipal } from './principals';
import type { ActiveDispatch } from './tasks';
import { emitTaskEvent, mapTask } from './tasks';
import {
  applyLocked,
  isStale,
  loadTask,
  stillInState,
} from './tasksAutomationLocking';
import {
  type DispatchResult,
  failedDispatchIds,
  runDispatch,
} from './tasksDispatch';
import type { RetryPolicy, WorkflowDispatch } from './workflowsValidation';

const log = createDebug('soat:tasks');

/**
 * Outcome of running a state's dispatch under its (optional) retry policy.
 * `attempt` is the 1-based attempt the outcome came from, or `undefined` when no
 * retry policy was declared — a dispatch without `retry` records no attempt
 * counter at all, so its `active_dispatch` keeps the pre-retry shape (#822).
 */
export type DispatchAttemptOutcome =
  | {
      kind: 'completed';
      dispatched: DispatchResult;
      attempt: number | undefined;
    }
  | { kind: 'failed'; error: unknown; attempt: number | undefined }
  | { kind: 'abandoned' };

// Backoff before `attempt` (always ≥ 2 here — the first attempt never waits):
// `backoff_seconds * backoff_multiplier^(attempt - 2)`.
const backoffMs = (args: { retry: RetryPolicy; attempt: number }): number => {
  const base = args.retry.backoffSeconds ?? 0;
  const multiplier = args.retry.backoffMultiplier ?? 1;
  return base * multiplier ** (args.attempt - 2) * 1000;
};

// Sleep the backoff in slices, re-reading the task between them, so a card that
// leaves the state mid-backoff abandons its remaining attempts promptly instead
// of holding the detached automation promise open for the whole delay. Returns
// false when the task went stale — the caller stops retrying.
const STALENESS_POLL_MS = 500;

const waitForRetry = async (args: {
  taskPublicId: string;
  stateName: string;
  token: number;
  delayMs: number;
}): Promise<boolean> => {
  let remaining = args.delayMs;
  for (;;) {
    const task = await loadTask(args.taskPublicId);
    if (isStale({ task, stateName: args.stateName, token: args.token })) {
      return false;
    }
    if (remaining <= 0) return true;
    const slice = Math.min(remaining, STALENESS_POLL_MS);
    remaining -= slice;
    await new Promise((resolve) => {
      setTimeout(resolve, slice);
    });
  }
};

const writeAttemptState = async (args: {
  taskPublicId: string;
  stateName: string;
  token: number;
  dispatch: ActiveDispatch;
}) => {
  return applyLocked({
    taskPublicId: args.taskPublicId,
    guard: stillInState({ stateName: args.stateName, token: args.token }),
    mutate: (task) => {
      task.activeDispatch = args.dispatch;
    },
  });
};

// Records a failed attempt that will be retried: leaves `automation_status` at
// `running` (the automation has not failed — only this attempt did) while
// writing that attempt's provenance, and emits an event so the flake stays
// visible in the activity feed even when a later attempt succeeds.
const recordRetriedAttempt = async (args: {
  taskPublicId: string;
  stateName: string;
  token: number;
  projectId: number;
  dispatchKind: ActiveDispatch['kind'];
  attempt: number;
  maxAttempts: number;
  error: unknown;
}): Promise<void> => {
  const { generationId, orchestrationRunId } = failedDispatchIds(args.error);
  const task = await writeAttemptState({
    taskPublicId: args.taskPublicId,
    stateName: args.stateName,
    token: args.token,
    dispatch: {
      kind: args.dispatchKind,
      id: generationId ?? orchestrationRunId,
      status: 'failed',
      attempt: args.attempt,
    },
  });
  if (!task) return;

  await emitTaskEvent({
    type: 'tasks.automation_retrying',
    projectId: args.projectId,
    task: mapTask(task),
    extra: {
      attempt: args.attempt,
      max_attempts: args.maxAttempts,
      error:
        args.error instanceof Error ? args.error.message : String(args.error),
      generation_id: generationId,
      orchestration_run_id: orchestrationRunId,
    },
  });
};

type AttemptContext = {
  taskPublicId: string;
  stateName: string;
  token: number;
  projectId: number;
  dispatch: WorkflowDispatch;
  dispatchKind: ActiveDispatch['kind'];
  inputs: Record<string, unknown>;
  retry: RetryPolicy | null;
  principal?: RequestPrincipal;
};

// One attempt: marks the (re)dispatch running with its attempt number, then runs
// it, persisting the dispatch id as soon as it is known — before the blocking
// wait — so cancellation-on-exit can reach a genuinely in-flight run (#606).
const runOneAttempt = async (args: {
  context: AttemptContext;
  attempt: number;
}): Promise<DispatchResult> => {
  const { context: ctx, attempt } = args;
  const attemptKey = ctx.retry ? { attempt } : {};
  if (attempt > 1) {
    await writeAttemptState({
      taskPublicId: ctx.taskPublicId,
      stateName: ctx.stateName,
      token: ctx.token,
      dispatch: {
        kind: ctx.dispatchKind,
        id: null,
        status: 'running',
        attempt,
      },
    });
  }
  return runDispatch({
    dispatch: ctx.dispatch,
    projectId: ctx.projectId,
    inputs: ctx.inputs,
    principal: ctx.principal,
    onDispatchStarted: async ({ generationId, orchestrationRunId }) => {
      await writeAttemptState({
        taskPublicId: ctx.taskPublicId,
        stateName: ctx.stateName,
        token: ctx.token,
        dispatch: {
          kind: ctx.dispatchKind,
          id: generationId ?? orchestrationRunId,
          status: 'running',
          ...attemptKey,
        },
      });
    },
  });
};

// A non-final attempt failed: record it, then wait out the backoff. Returns
// false when the task left the state meanwhile, so the retries are abandoned.
const prepareRetry = async (args: {
  context: AttemptContext;
  attempt: number;
  maxAttempts: number;
  error: unknown;
}): Promise<boolean> => {
  const { context: ctx, attempt } = args;
  log(
    'runDispatchWithRetry: attempt %d/%d failed task=%s, retrying',
    attempt,
    args.maxAttempts,
    ctx.taskPublicId
  );
  await recordRetriedAttempt({
    taskPublicId: ctx.taskPublicId,
    stateName: ctx.stateName,
    token: ctx.token,
    projectId: ctx.projectId,
    dispatchKind: ctx.dispatchKind,
    attempt,
    maxAttempts: args.maxAttempts,
    error: args.error,
  });
  return waitForRetry({
    taskPublicId: ctx.taskPublicId,
    stateName: ctx.stateName,
    token: ctx.token,
    // `attempt < maxAttempts` here only when a retry policy exists.
    delayMs: ctx.retry
      ? backoffMs({ retry: ctx.retry, attempt: attempt + 1 })
      : 0,
  });
};

/**
 * Runs one state dispatch, retrying its **execution** failures (a tool/agent
 * error, an orchestration run that ends `failed`) up to `retry.max_attempts`
 * with the declared backoff. Routing is never retried — `on_complete` is the
 * caller's job, and `on_failure` fires only on a `failed` outcome, i.e. after
 * the last attempt. With no `retry` policy this is exactly one attempt with no
 * attempt bookkeeping.
 *
 * Attempts respect the same cancellation-on-exit token a single attempt does: if
 * the task leaves the state between attempts the remaining ones are abandoned
 * (`kind: 'abandoned'`).
 */
export const runDispatchWithRetry = async (
  args: AttemptContext
): Promise<DispatchAttemptOutcome> => {
  const maxAttempts = args.retry?.maxAttempts ?? 1;
  const attemptNumber = (attempt: number) => {
    return args.retry ? attempt : undefined;
  };

  for (let attempt = 1; ; attempt += 1) {
    try {
      const dispatched = await runOneAttempt({ context: args, attempt });
      return {
        kind: 'completed',
        dispatched,
        attempt: attemptNumber(attempt),
      };
    } catch (error) {
      if (attempt >= maxAttempts) {
        return { kind: 'failed', error, attempt: attemptNumber(attempt) };
      }
      const alive = await prepareRetry({
        context: args,
        attempt,
        maxAttempts,
        error,
      });
      if (!alive) {
        log(
          'runDispatchWithRetry: abandoning retries, task=%s left the state',
          args.taskPublicId
        );
        return { kind: 'abandoned' };
      }
    }
  }
};
