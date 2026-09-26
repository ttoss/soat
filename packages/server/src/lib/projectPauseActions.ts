import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitResourceEvent } from './eventBus';
import {
  pauseOrchestrationRun,
  resumeOrchestrationRun,
} from './orchestrationRunActions';
import { clearRunPause, PAUSABLE_RUN_STATUSES } from './orchestrationRunPause';
import type { RequestPrincipal } from './principals';
import { readPauseReason } from './projectPause';
import { getProjectOrThrow, mapProject } from './projects';
import { pauseTask, resumeTask } from './tasksPauseActions';
import { computeNextFireAt } from './triggerValidation';

const log = createDebug('soat:projects');

/**
 * The two actions behind a project pause. The primitives every start and
 * driver consults are in `projectPause.ts`; these reach the run and task
 * actions, so they live apart from them.
 */

type MappedProject = ReturnType<typeof mapProject>;

/**
 * A settled run or a closed task is one the sweep raced: it finished between
 * the listing and the pause. There is nothing left to stop, so it is skipped.
 */
const isAlreadySettled = (error: unknown): boolean => {
  return (
    error instanceof DomainError &&
    (error.code === 'ORCHESTRATION_RUN_NOT_PAUSABLE' ||
      error.code === 'TASK_NOT_PAUSABLE')
  );
};

const pauseLiveRuns = async (args: {
  projectId: number;
  reason: string | null;
}): Promise<void> => {
  const runs = await db.OrchestrationRun.findAll({
    where: {
      projectId: args.projectId,
      status: [...PAUSABLE_RUN_STATUSES],
      pauseRequestedAt: null,
    },
    attributes: ['publicId'],
    order: [['id', 'ASC']],
  });
  for (const run of runs) {
    try {
      await pauseOrchestrationRun({
        runPublicId: run.publicId,
        reason: args.reason,
        origin: 'project',
      });
    } catch (error) {
      if (!isAlreadySettled(error)) throw error;
    }
  }
};

const pauseOpenTasks = async (args: {
  projectId: number;
  reason: string | null;
}): Promise<void> => {
  const tasks = await db.Task.findAll({
    where: {
      projectId: args.projectId,
      status: 'open',
      pauseRequestedAt: null,
    },
    attributes: ['publicId'],
    order: [['id', 'ASC']],
  });
  for (const task of tasks) {
    try {
      await pauseTask({
        id: task.publicId as string,
        reason: args.reason,
        origin: 'project',
      });
    } catch (error) {
      if (!isAlreadySettled(error)) throw error;
    }
  }
};

const emitProjectEvent = (args: {
  type: 'projects.paused' | 'projects.resumed';
  projectId: number;
  project: MappedProject;
}): void => {
  emitResourceEvent({
    type: args.type,
    projectId: args.projectId,
    projectPublicId: args.project.id,
    resourceType: 'project',
    resourceId: args.project.id,
    data: { project: args.project },
  });
};

/**
 * Pauses everything the project runs.
 *
 * The project is flagged first, so every start from here on is refused and
 * every run or task written from here on is born paused; only then are the
 * runs and tasks already live swept. Swept in the other order, a run started
 * between the sweep and the flag would escape both.
 *
 * Idempotent: pausing a paused project answers it unchanged and keeps the
 * first reason, so an automation that fires on every anomaly writes once.
 */
export const pauseProject = async (args: {
  id: string;
  /** Validated here: see `readPauseReason`. */
  reason: unknown;
}): Promise<MappedProject> => {
  log('pauseProject: id=%s', args.id);
  const reason = readPauseReason(args.reason);
  const project = await getProjectOrThrow(args.id);
  const projectId = project.id as number;

  const [claimed] = await db.Project.update(
    { pausedAt: new Date(), pauseReason: reason },
    { where: { id: projectId, pausedAt: null } }
  );
  await project.reload();
  if (claimed === 0) {
    log('pauseProject: id=%s already paused', args.id);
    return mapProject(project);
  }

  await pauseLiveRuns({ projectId, reason });
  await pauseOpenTasks({ projectId, reason });

  const mapped = mapProject(project);
  emitProjectEvent({ type: 'projects.paused', projectId, project: mapped });
  return mapped;
};

/**
 * The resumes in flight, so a caller that has to observe them settle — a test,
 * a graceful shutdown — can wait for them instead of for a timer.
 */
const inFlightResumes = new Set<Promise<void>>();

export const flushProjectResumes = async (): Promise<void> => {
  await Promise.all([...inFlightResumes]);
};

/**
 * Hands one run back. A run parked `awaiting_input` is resumed the way its own
 * `resume` route resumes it, in the background: re-driving every run the
 * project held inside the request would hold the request for as long as the
 * slowest of them. A run still driving never reached the checkpoint that
 * would have parked it, so lifting its flag is all there is to do.
 */
const resumeRun = async (
  run: InstanceType<typeof db.OrchestrationRun>
): Promise<void> => {
  if (run.status !== 'awaiting_input') {
    await clearRunPause({ runRecord: run });
    return;
  }
  const resumed = resumeOrchestrationRun({ runPublicId: run.publicId })
    .then(() => {
      return undefined;
    })
    .catch((error: unknown) => {
      log('resumeProject: run=%s did not resume %o', run.publicId, error);
    })
    .finally(() => {
      inFlightResumes.delete(resumed);
    });
  inFlightResumes.add(resumed);
};

/**
 * Re-anchors the schedules the pause held: a trigger whose occurrence fell due
 * while paused fires at its next occurrence from now, not the moment the
 * project resumes.
 */
const reanchorSchedules = async (args: {
  projectId: number;
}): Promise<void> => {
  const now = new Date();
  const due = await db.Trigger.findAll({
    where: {
      projectId: args.projectId,
      type: 'schedule',
      active: true,
      nextFireAt: { [Op.lte]: now },
    },
  });
  for (const trigger of due) {
    const cron = trigger.cron as string | null;
    if (!cron) continue;
    await trigger.update({ nextFireAt: computeNextFireAt(cron, now) });
  }
};

/**
 * Lifts the project's pause and hands back exactly what it held: the runs and
 * tasks marked `pausedByProject`. A run or task an operator paused before the
 * project did keeps its own pause.
 *
 * The flag is cleared first, because the run and task resumes refuse while it
 * is set. `principal` is who resumed: a task's suppressed dispatch runs as the
 * one who decided to spend again, as its own `resume` does.
 */
export const resumeProject = async (args: {
  id: string;
  principal?: RequestPrincipal;
}): Promise<MappedProject> => {
  log('resumeProject: id=%s', args.id);
  const project = await getProjectOrThrow(args.id);
  const projectId = project.id as number;

  const [claimed] = await db.Project.update(
    { pausedAt: null, pauseReason: null },
    { where: { id: projectId, pausedAt: { [Op.ne]: null } } }
  );
  if (claimed === 0) {
    throw new DomainError(
      'PROJECT_NOT_PAUSED',
      `Project '${args.id}' is not paused.`
    );
  }
  await project.reload();

  await reanchorSchedules({ projectId });

  const tasks = await db.Task.findAll({
    where: { projectId, pausedByProject: true },
    attributes: ['publicId'],
  });
  // One task or run that cannot be handed back must not strand the rest: the
  // project is already running, and each keeps its own `resume`.
  for (const task of tasks) {
    await resumeTask({
      id: task.publicId as string,
      principal: args.principal,
    }).catch((error: unknown) => {
      log('resumeProject: task=%s did not resume %o', task.publicId, error);
    });
  }

  const runs = await db.OrchestrationRun.findAll({
    where: { projectId, pausedByProject: true },
  });
  for (const run of runs) {
    await resumeRun(run).catch((error: unknown) => {
      log('resumeProject: run=%s did not resume %o', run.publicId, error);
    });
  }

  const mapped = mapProject(project);
  emitProjectEvent({ type: 'projects.resumed', projectId, project: mapped });
  return mapped;
};
