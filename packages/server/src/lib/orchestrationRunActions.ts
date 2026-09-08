import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  nodeExecutionsInclude,
  type OrchestrationRunRow,
  orchestrationRuns,
} from './orchestrationAccessor';
import { resumeOrchestrationRunExecution } from './orchestrationEngine';
import { findStartNodes } from './orchestrationGraph';
import { resolveRunGraph } from './orchestrationRunGraph';
import { mapRunWithIncludes } from './orchestrationRunHelpers';
import {
  flagRunTreePaused,
  isRunPaused,
  parkPausedRun,
  PAUSABLE_RUN_STATUSES,
} from './orchestrationRunPause';
import type { MappedOrchestrationRun } from './orchestrations';
import { mapOrchestrationRun } from './orchestrations';

const log = createDebug('soat:orchestrations');

export type MappedOrchestrationCheckpoint = {
  orchestrationRunId: string;
  nodeId: string;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  createdAt: Date;
};

export const cancelOrchestrationRun = async (args: {
  runPublicId: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun> => {
  log('cancelOrchestrationRun %o', { runPublicId: args.runPublicId });

  // Node executions on top of the accessor's includes: the cancel response
  // reports them. Only the includes vary — the scoped `where` does not.
  const run = (await db.OrchestrationRun.findOne({
    where: orchestrationRuns.scopedWhere({
      id: args.runPublicId,
      projectIds: args.projectIds,
    }),
    include: [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
      nodeExecutionsInclude(),
    ],
  })) as OrchestrationRunRow | null;
  if (!run) throw orchestrationRuns.notFound(args.runPublicId);

  if (
    run.status === 'succeeded' ||
    run.status === 'failed' ||
    run.status === 'cancelled' ||
    run.status === 'expired'
  ) {
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_CANCELLABLE',
      `Run '${args.runPublicId}' is already in terminal state '${run.status}'.`
    );
  }

  await run.update({ status: 'cancelled', completedAt: new Date() });

  return mapOrchestrationRun(run);
};

/**
 * The nodes a `queued` or `sleeping` run must re-drive once its pause is lifted.
 * A queued run has executed nothing, so its frontier is the graph's start nodes
 * — read here rather than left empty, because an empty `activeNodes` would make
 * `resume` settle the run as succeeded without running a node.
 */
const pausedFrontier = async (args: {
  run: OrchestrationRunRow;
}): Promise<string[]> => {
  const { run } = args;
  const activeNodes = run.activeNodes as string[];
  if (activeNodes.length > 0) return activeNodes;

  const { nodes, edges } = await resolveRunGraph({
    run,
    orchestration: run.orchestration,
  });
  return findStartNodes(nodes, edges);
};

/**
 * Pauses a run in flight: the stop `cancel` cannot be, because a pause keeps the
 * checkpoint and the existing `resume` re-drives from it (#1237).
 *
 * The flag is written first, and to the whole run tree — a parent whose
 * `loop` / `sub_orchestration` children kept generating would have paused
 * nothing. What happens next depends on what the run was doing:
 *
 * - `running` — the run loop reads the flag at its next checkpoint and parks
 *   there, so the round already in flight finishes and nothing after it starts.
 * - `queued` / `sleeping` — nothing is driving it, so it is parked here and the
 *   caller sees `awaiting_input` immediately. The park is status-guarded: a
 *   worker that claimed the run in between wins, and the flag it set is honored
 *   at that run's next checkpoint instead.
 * - `awaiting_input` — a node already says what the run waits for, and that
 *   `required_action` stands. The pause is still recorded, which is what makes
 *   `submit-human-input` refuse until the run is resumed.
 *
 * Idempotent: pausing an already-paused run answers with it unchanged, so a
 * reconciliation loop that pauses on every tick writes once.
 */
export const pauseOrchestrationRun = async (args: {
  runPublicId: string;
  projectIds?: number[];
  reason?: string | null;
}): Promise<MappedOrchestrationRun> => {
  log('pauseOrchestrationRun %o', { runPublicId: args.runPublicId });

  const run = await orchestrationRuns.getByPublicId({
    id: args.runPublicId,
    projectIds: args.projectIds,
  });

  if (!PAUSABLE_RUN_STATUSES.has(run.status)) {
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_PAUSABLE',
      `Run '${args.runPublicId}' is already in terminal state '${run.status}'.`,
      { status: run.status }
    );
  }

  if (isRunPaused(run)) return mapRunWithIncludes(run.id as number);

  const reason = args.reason ?? null;
  await flagRunTreePaused({
    runPublicId: run.publicId,
    reason,
    requestedAt: new Date(),
  });
  await run.reload();

  if (run.status === 'queued' || run.status === 'sleeping') {
    await parkPausedRun({
      runRecord: run,
      reason,
      activeNodes: await pausedFrontier({ run }),
      guardStatuses: ['queued', 'sleeping'],
    });
  }

  return mapRunWithIncludes(run.id as number);
};

export const submitHumanInput = async (args: {
  runPublicId: string;
  projectIds?: number[];
  nodeId: string;
  output: Record<string, unknown>;
}): Promise<MappedOrchestrationRun> => {
  log('submitHumanInput %o', {
    runPublicId: args.runPublicId,
    nodeId: args.nodeId,
  });

  const run = await orchestrationRuns.getByPublicId({
    id: args.runPublicId,
    projectIds: args.projectIds,
  });

  if (run.status !== 'awaiting_input')
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_AWAITING_INPUT',
      `Run '${args.runPublicId}' is not awaiting input (status: '${run.status}').`
    );

  // An operator pause has no payload to supply, and a pause standing behind a
  // human node must not be lifted by satisfying it — resume the run first, then
  // submit (#1237).
  if (isRunPaused(run))
    throw new DomainError(
      'ORCHESTRATION_RUN_PAUSED',
      `Run '${args.runPublicId}' is paused; resume it before submitting human input.`
    );

  const activeNodes = run.activeNodes as string[];
  if (!activeNodes.includes(args.nodeId))
    throw new DomainError(
      'ORCHESTRATION_HUMAN_NODE_MISMATCH',
      `Node '${args.nodeId}' is not the active human node for run '${args.runPublicId}'.`
    );

  return resumeOrchestrationRunExecution({
    run,
    humanNodeId: args.nodeId,
    humanOutput: args.output,
  });
};

export const resumeOrchestrationRun = async (args: {
  runPublicId: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun> => {
  log('resumeOrchestrationRun %o', { runPublicId: args.runPublicId });

  const run = await orchestrationRuns.getByPublicId({
    id: args.runPublicId,
    projectIds: args.projectIds,
  });

  if (run.status !== 'awaiting_input')
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_AWAITING_INPUT',
      `Run '${args.runPublicId}' is not awaiting input (status: '${run.status}').`
    );

  return resumeOrchestrationRunExecution({ run, liftPause: true });
};
