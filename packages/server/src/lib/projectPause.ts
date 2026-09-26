import { db } from '../db';
import { DomainError } from '../errors';

/**
 * A project-wide pause: the kill switch that stops everything a project runs
 * with one call.
 *
 * It is two halves, and neither bounds anything alone. **Refusing starts**
 * ({@link assertProjectAcceptsWork}) closes every door new work enters by —
 * a request, a trigger firing, a resume. **Parking what is in motion** reuses
 * the run and task pauses that already exist: every live run and task is
 * flagged the way an operator pause flags it, marked `pausedByProject` so the
 * project's resume lifts exactly those, and the schedule and eval drivers skip
 * a paused project outright.
 *
 * Work a driver already owns — an orchestration node, an eval item, a task
 * dispatch — is not refused here: it was admitted before the pause, and its
 * own checkpoint is where it stops. Refusing it mid-flight would fail a run
 * the pause exists to keep resumable.
 *
 * This file holds the primitives only, so the drivers that consult the pause
 * can import it without reaching the actions in `projectPauseActions.ts`.
 */

/** The `pause_reason` column's width. */
export const PAUSE_REASON_MAX_LENGTH = 256;

/**
 * The reason a pause request carries: absent or `null` is none, anything but a
 * string of at most {@link PAUSE_REASON_MAX_LENGTH} characters is a `400`.
 */
export const readPauseReason = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > PAUSE_REASON_MAX_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `reason must be a string of at most ${PAUSE_REASON_MAX_LENGTH} characters.`,
      { field: 'reason' }
    );
  }
  return value;
};

export type ProjectPause = {
  projectPublicId: string;
  pausedAt: Date;
  reason: string | null;
};

/** The pause in force on a project, or null when it runs. */
export const readProjectPause = async (args: {
  projectId: number;
}): Promise<ProjectPause | null> => {
  const project = await db.Project.findOne({
    where: { id: args.projectId },
    attributes: ['publicId', 'pausedAt', 'pauseReason'],
  });
  if (!project?.pausedAt) return null;
  return {
    projectPublicId: project.publicId,
    pausedAt: project.pausedAt,
    reason: project.pauseReason,
  };
};

export const projectPausedError = (pause: ProjectPause): DomainError => {
  return new DomainError(
    'PROJECT_PAUSED',
    `Project '${pause.projectPublicId}' is paused; resume it before starting new work.`,
    {
      project_id: pause.projectPublicId,
      paused_at: pause.pausedAt.toISOString(),
      pause_reason: pause.reason,
    }
  );
};

/** Throws `PROJECT_PAUSED` when the project is paused. */
export const assertProjectAcceptsWork = async (args: {
  projectId: number;
}): Promise<void> => {
  const pause = await readProjectPause(args);
  if (pause) throw projectPausedError(pause);
};

/**
 * {@link assertProjectAcceptsWork} for work named by the agent that runs it.
 * An agent that does not resolve is left to the caller's own lookup, which
 * answers the `404` a missing agent deserves.
 */
export const assertAgentProjectAcceptsWork = async (args: {
  agentPublicId: string;
}): Promise<void> => {
  const agent = await db.Agent.findOne({
    where: { publicId: args.agentPublicId },
    attributes: ['projectId'],
  });
  if (!agent) return;
  await assertProjectAcceptsWork({ projectId: agent.projectId as number });
};
