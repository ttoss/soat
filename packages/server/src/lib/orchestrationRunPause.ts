import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import type { ScheduledWait } from './orchestrationNodeTypes';
import { readProjectPause } from './projectPause';

const log = createDebug('soat:orchestrations');

/**
 * An operator pause: the stop a run in flight has that `cancel` cannot be.
 *
 * Cancelling discards a run's work, so a long run stopped at its 40th of 50
 * nodes for a reason that clears minutes later has to start over. A pause parks
 * it as `awaiting_input` at its next checkpoint and the existing `resume`
 * re-drives it from there — the same deferral a `human` node already gives.
 *
 * `pauseRequestedAt` is the whole mechanism: the run loop reads it after each
 * checkpoint, the queued/wake/redrive drivers read it before driving, and it
 * stays set while the run is parked so nothing but `resume` lifts it.
 *
 * A project pause (`projectPause.ts`) sets the same flag on every live run of
 * the project, with `pausedByProject` recording whose pause it is: the
 * project's resume lifts those, and a pause an operator set on the run first
 * is left for the run's own `resume`.
 */

/** Whose pause a run carries — its own operator's, or its project's. */
export type RunPauseOrigin = 'operator' | 'project';

/** A run status a pause can still act on — anything not yet settled. */
export const PAUSABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'sleeping',
  'awaiting_input',
]);

/**
 * Whether an operator pause is in force. One predicate, so the loop, the three
 * background drivers, `submit-human-input` and the pause action itself cannot
 * disagree about what "paused" means.
 */
export const isRunPaused = (run: {
  pauseRequestedAt: Date | null;
}): boolean => {
  return run.pauseRequestedAt != null;
};

export type PauseRequiredAction = {
  type: 'paused';
  reason: string | null;
};

export const pausedRequiredAction = (
  reason: string | null
): PauseRequiredAction => {
  return { type: 'paused', reason };
};

/**
 * Parks a run on its operator pause: `awaiting_input`, carrying a
 * `required_action` that names the pause as operator-initiated rather than a
 * node's, with `activeNodes` set to the frontier `resume` must re-drive.
 *
 * `wakeAt` / `wakeContext` are deliberately **not** cleared, which is what lets
 * a run paused mid-timer keep its scheduled wake: the scheduler only claims a
 * `sleeping` run, so the wake finds `awaiting_input` and does nothing, and
 * `resume` puts the run back to `sleeping` for the scheduler to pick up at the
 * instant it was already due. Pass `scheduledWait` to write that context in the
 * same update, for a wait and a pause landing in the same round.
 *
 * `guardStatuses` makes the park lose to a run that moved underneath it — the
 * pause action parks a `queued` or `sleeping` run itself, and a worker may have
 * claimed it in between. Returns whether it parked; the flag is set either way,
 * so a lost park is honored at the next checkpoint instead.
 */
export const parkPausedRun = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  reason: string | null;
  activeNodes: string[];
  state?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
  scheduledWait?: ScheduledWait | null;
  guardStatuses?: readonly string[];
  /**
   * The trace the round produced, persisted the way a settling run persists it —
   * only when the run has none yet. Without it a run paused before any later
   * traced node would report a `trace_id` from after the pause.
   */
  traceId?: string | null;
}): Promise<boolean> => {
  const { runRecord } = args;
  const [claimed] = await db.OrchestrationRun.update(
    {
      status: 'awaiting_input',
      activeNodes: args.activeNodes,
      requiredAction: pausedRequiredAction(args.reason),
      error: null,
      output: null,
      completedAt: null,
      // A parked run holds no worker, so it releases its lease; the reaper only
      // reclaims a `running` one.
      leaseExpiresAt: null,
      ...(args.state ? { state: args.state } : {}),
      ...(args.artifacts ? { artifacts: args.artifacts } : {}),
      ...(runRecord.traceId || !args.traceId ? {} : { traceId: args.traceId }),
      ...(args.scheduledWait
        ? {
            wakeAt: new Date(Date.now() + args.scheduledWait.resumeInMs),
            wakeContext: {
              nodeId: args.scheduledWait.nodeId,
              resume: args.scheduledWait.resume,
            },
          }
        : {}),
    },
    {
      where: {
        id: runRecord.id as number,
        ...(args.guardStatuses ? { status: [...args.guardStatuses] } : {}),
      },
    }
  );
  await runRecord.reload();
  log(
    'parkPausedRun: run=%s parked=%s activeNodes=%o',
    runRecord.publicId,
    claimed > 0,
    args.activeNodes
  );
  return claimed > 0;
};

/**
 * Flags a run and every descendant it started, so a pause on a parent bounds
 * the `loop` / `sub_orchestration` children spending on its behalf — without
 * them the parent's pause bounds nothing.
 *
 * Walked level by level over the denormalized `parentRunId`, so no recursive
 * query is needed and the walk is bounded by `MAX_ORCHESTRATION_RUN_DEPTH`.
 * Terminal descendants are skipped: there is nothing left to stop, and flagging
 * one would make `isRunPaused` true for a run `resume` can never lift it from.
 */
export const flagRunTreePaused = async (args: {
  runPublicId: string;
  reason: string | null;
  requestedAt: Date;
  origin: RunPauseOrigin;
}): Promise<void> => {
  const values = {
    pauseRequestedAt: args.requestedAt,
    pauseReason: args.reason,
    pausedByProject: args.origin === 'project',
  };
  let frontier = [args.runPublicId];
  while (frontier.length > 0) {
    await db.OrchestrationRun.update(values, {
      where: {
        publicId: frontier,
        status: [...PAUSABLE_RUN_STATUSES],
        pauseRequestedAt: null,
      },
    });
    const children = await db.OrchestrationRun.findAll({
      where: {
        parentRunId: frontier,
        status: [...PAUSABLE_RUN_STATUSES],
      },
      attributes: ['publicId'],
    });
    frontier = children.map((child) => {
      return child.publicId;
    });
  }
};

/**
 * Lifts the pause on one run.
 *
 * Deliberately not a tree walk, unlike {@link flagRunTreePaused}: a child that
 * parked has already handed its parent an outcome, so the parent's `resume`
 * re-drives the parent's own frontier and a descendant is resumed by its own
 * id (reachable through `parent_orchestration_run_id`). Stopping fans out
 * because spend does; restarting does not, because each run's checkpoint is its
 * own.
 */
export const clearRunPause = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
}): Promise<void> => {
  if (!isRunPaused(args.runRecord)) return;
  await args.runRecord.update({
    pauseRequestedAt: null,
    pauseReason: null,
    pausedByProject: false,
  });
};

/**
 * Flags an unflagged run as its paused project's, returning whether the
 * project is paused. The project's pause sweep flags every live run it finds;
 * a run written while the sweep ran is caught by the next driver to touch it,
 * so the project's resume finds it with the rest.
 */
const adoptProjectPause = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<boolean> => {
  const projectPause = await readProjectPause({
    projectId: args.run.projectId as number,
  });
  if (!projectPause) return false;
  await db.OrchestrationRun.update(
    {
      pauseRequestedAt: projectPause.pausedAt,
      pauseReason: projectPause.reason,
      pausedByProject: true,
    },
    { where: { id: args.run.id as number, pauseRequestedAt: null } }
  );
  await args.run.reload();
  return true;
};

/**
 * {@link isRunPaused} for a driver about to drive a run it loaded: the run's
 * own flag, or its project's pause, which it adopts. The row is reloaded when
 * it adopts, so `pauseReason` on it is the project's.
 */
export const isRunPausedForDrive = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
}): Promise<boolean> => {
  if (isRunPaused(args.run)) return true;
  return adoptProjectPause({ run: args.run });
};

/**
 * The pause a driver must honor before it drives, re-read from the database
 * rather than taken off the in-memory row: the flag is written by a request
 * while the run is being driven, so the copy the driver loaded predates it.
 */
export const readRunPause = async (args: {
  orchestrationRunId: number;
}): Promise<{ paused: boolean; reason: string | null }> => {
  const row = await db.OrchestrationRun.findOne({
    where: { id: args.orchestrationRunId },
  });
  if (!row || !(await isRunPausedForDrive({ run: row }))) {
    return { paused: false, reason: null };
  }
  return { paused: true, reason: row.pauseReason };
};

/**
 * The pause reason to carry into a child run: a `loop` /
 * `sub_orchestration` child started while its parent is paused is born paused,
 * so it parks at its own first checkpoint instead of running a whole graph the
 * parent has already been stopped from entering. {@link flagRunTreePaused}
 * cannot reach it — the row does not exist yet when the pause is requested.
 */
export const inheritedPause = async (args: {
  parentRunId?: string;
  projectId: number;
}): Promise<{
  pauseRequestedAt: Date | null;
  pauseReason: string | null;
  pausedByProject: boolean;
}> => {
  const parent = args.parentRunId
    ? await db.OrchestrationRun.findOne({
        where: {
          publicId: args.parentRunId,
          pauseRequestedAt: { [Op.ne]: null },
        },
        attributes: ['pauseRequestedAt', 'pauseReason', 'pausedByProject'],
      })
    : null;
  if (parent) {
    return {
      pauseRequestedAt: parent.pauseRequestedAt,
      pauseReason: parent.pauseReason,
      pausedByProject: parent.pausedByProject,
    };
  }
  // A child started while its project is paused, before the sweep reached its
  // parent, is still born paused — and so is any run a start admitted just
  // before the pause landed.
  const projectPause = await readProjectPause({ projectId: args.projectId });
  return {
    pauseRequestedAt: projectPause?.pausedAt ?? null,
    pauseReason: projectPause?.reason ?? null,
    pausedByProject: projectPause !== null,
  };
};
