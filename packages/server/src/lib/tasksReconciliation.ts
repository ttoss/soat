import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { applyInputMapping } from './jsonLogicMapping';
import { mapRunWithIncludes } from './orchestrationRunHelpers';
import type { MappedOrchestrationRun } from './orchestrations';
import { type ActiveDispatch, stateByName } from './tasks';
import { routeSettledDispatch } from './tasksAutomation';
import {
  applyLocked,
  loadTask,
  type TaskWithWorkflow,
} from './tasksAutomationLocking';
import {
  NON_SUCCESS_TERMINAL_STATUSES,
  RUN_IN_FLIGHT_STATUSES,
} from './tasksDispatch';
import { resolveTaskDefinition } from './taskWorkflowDefinition';
import type { OnEnter } from './workflowsValidation';

const log = createDebug('soat:tasks');

/**
 * How long a dispatch may read `running` before the reconciler considers it
 * orphaned. The window exists because a healthy dispatch is awaited in-process
 * (`waitForOrchestrationRunSettlement`), and that awaiter routes the outcome
 * within milliseconds of the run settling. Reconciling sooner would race it —
 * `claimOrphanedDispatch` would still pick exactly one winner, but the loser
 * would do its work for nothing. A minute is far longer than any healthy
 * hand-off and far shorter than the sleeps this exists to survive.
 */
const DEFAULT_GRACE_MS = 60_000;

const graceMs = (): number => {
  const envMs = Number(process.env.TASKS_DISPATCH_RECONCILE_GRACE_MS);
  return Number.isFinite(envMs) && envMs >= 0 ? envMs : DEFAULT_GRACE_MS;
};

/**
 * Open tasks whose dispatch has read `running` for longer than the grace
 * window. Candidates only: whether the dispatched record actually settled is
 * decided per row in {@link claimOrphanedDispatch}, because that answer lives
 * in another table and cannot be joined through the `active_dispatch` JSON.
 */
export const findStaleDispatches = async (args: {
  now: Date;
  limit: number;
}): Promise<TaskWithWorkflow[]> => {
  return db.Task.findAll({
    where: {
      status: 'open',
      automationStatus: 'running',
      enteredStateAt: { [Op.lte]: new Date(args.now.getTime() - graceMs()) },
    },
    order: [['enteredStateAt', 'ASC']],
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Workflow, as: 'workflow' },
    ],
    limit: args.limit,
  }) as Promise<TaskWithWorkflow[]>;
};

/**
 * The run a task's `active_dispatch` points at, if it has reached a resting
 * point. `RUN_IN_FLIGHT_STATUSES` is the same set the in-process awaiter uses,
 * imported rather than restated so a reconciled outcome can never disagree with
 * a live one about what "settled" means.
 *
 * Returns `null` while the run is still in flight, when the dispatch names no
 * run, or when the dispatch is a `generation` — an agent generation can park in
 * `requires_action` waiting for client tool outputs, which reads identical to an
 * orphan from here and must not be routed. Reconciling those needs its own
 * settled-ness rule; orchestration runs are the kind that sleep for hours and
 * the kind this exists for.
 */
const settledRun = async (
  task: TaskWithWorkflow
): Promise<MappedOrchestrationRun | null> => {
  const dispatch = task.activeDispatch as ActiveDispatch | null;
  if (!dispatch || dispatch.kind !== 'orchestration_run') return null;
  if (typeof dispatch.id !== 'string') return null;

  const row = await db.OrchestrationRun.findOne({
    where: { publicId: dispatch.id },
    attributes: ['id', 'status'],
  });
  if (!row) return null;
  if (
    RUN_IN_FLIGHT_STATUSES.has(row.status as MappedOrchestrationRun['status'])
  ) {
    return null;
  }
  return mapRunWithIncludes(row.id as number);
};

/** The `on_enter` of the state a task is currently parked in, if it declares one. */
const onEnterFor = async (
  task: TaskWithWorkflow
): Promise<OnEnter | undefined> => {
  if (!task.workflow) return undefined;
  const { states } = await resolveTaskDefinition({
    task,
    workflow: task.workflow,
  });
  return stateByName({ states, name: task.state })?.onEnter ?? undefined;
};

/**
 * Writes the settled outcome onto a task whose in-process awaiter is gone,
 * atomically and only while the dispatch is still the `running` one we found —
 * so a live awaiter that wakes up mid-sweep and a second instance sweeping the
 * same row both lose the race cleanly, exactly as `commitCompletion` does.
 *
 * The write mirrors `commitCompletion` / `handleFailure` field for field: the
 * task is left in the state a healthy dispatch would have left it in, and
 * routing (`on_complete` / `on_failure`) is a separate step, so a crash between
 * the two leaves a task that is `completed` but unrouted rather than one that
 * moved without a record.
 */
export const claimOrphanedDispatch = async (args: {
  task: TaskWithWorkflow;
}): Promise<boolean> => {
  const run = await settledRun(args.task);
  if (!run) return false;

  const onEnter = await onEnterFor(args.task);
  if (!onEnter) return false;

  // Classified by the dispatcher's own set, so a recovered run routes down the
  // branch a live one would have. `awaiting_input` is a success here for the
  // same reason it is there: it is a resting point the run can be resumed from,
  // not a failure.
  const succeeded = !NON_SUCCESS_TERMINAL_STATUSES.has(run.status);
  const dispatch = args.task.activeDispatch as ActiveDispatch;
  const enteredAt = (args.task.enteredStateAt as Date).getTime();

  const claimed = await applyLocked({
    taskPublicId: args.task.publicId as string,
    guard: (t) => {
      const current = t.activeDispatch as ActiveDispatch | null;
      return (
        t.automationStatus === 'running' &&
        t.state === args.task.state &&
        (t.enteredStateAt as Date).getTime() === enteredAt &&
        current?.id === dispatch.id
      );
    },
    mutate: (t) => {
      t.activeDispatch = {
        ...dispatch,
        status: succeeded ? 'completed' : 'failed',
      };
      t.automationStatus = succeeded ? 'completed' : 'failed';
      if (!succeeded) return;
      const result = run.state ?? {};
      const writes = applyInputMapping(onEnter.dispatch.payloadWrites, {
        task: {
          id: t.publicId,
          title: t.title,
          state: t.state,
          status: t.status,
          payload: t.payload,
          assignee: t.assignee,
          last_result: t.lastResult ?? null,
        },
        result,
      });
      t.lastResult = result;
      if (Object.keys(writes).length > 0) {
        t.payload = { ...(t.payload as Record<string, unknown>), ...writes };
      }
    },
  });

  if (claimed) {
    log(
      'claimOrphanedDispatch: reconciled task=%s run=%s status=%s',
      args.task.publicId,
      dispatch.id,
      run.status
    );
  }
  return Boolean(claimed);
};

/**
 * Routes a task whose outcome {@link claimOrphanedDispatch} just committed,
 * through the same `on_complete` / `on_failure` path the in-process awaiter
 * uses. Reloaded rather than reusing the claimed instance so the routing sees
 * the committed row.
 */
export const routeOrphanedDispatch = async (args: {
  taskPublicId: string;
}): Promise<void> => {
  const task = await loadTask(args.taskPublicId);
  if (!task) return;

  const onEnter = await onEnterFor(task);
  if (!onEnter) return;

  const dispatch = task.activeDispatch as ActiveDispatch | null;
  await routeSettledDispatch({
    task,
    onEnter,
    succeeded: task.automationStatus === 'completed',
    result: task.lastResult ?? {},
    orchestrationRunId: typeof dispatch?.id === 'string' ? dispatch.id : null,
  });
};
