import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  nodeExecutionsInclude,
  type OrchestrationRunRow,
  orchestrationRuns,
} from './orchestrationAccessor';
import { resumeOrchestrationRunExecution } from './orchestrationEngine';
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

  return resumeOrchestrationRunExecution({ run });
};
