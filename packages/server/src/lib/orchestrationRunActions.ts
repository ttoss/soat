import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { resumeOrchestrationRunExecution } from './orchestrationEngine';
import type { MappedOrchestrationRun } from './orchestrations';
import { mapOrchestrationRun } from './orchestrations';

const log = createDebug('soat:orchestrations');

export type MappedOrchestrationCheckpoint = {
  runId: string;
  nodeId: string;
  state: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  createdAt: Date;
};

export const cancelOrchestrationRun = async (args: {
  runPublicId: string;
  orchestrationPublicId?: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun> => {
  log('cancelOrchestrationRun %o', { runPublicId: args.runPublicId });

  const where: Record<string, unknown> = { publicId: args.runPublicId };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const include: object[] = [
    { model: db.Project, as: 'project' },
    { model: db.Orchestration, as: 'orchestration' },
  ];

  if (args.orchestrationPublicId) {
    include[1] = {
      model: db.Orchestration,
      as: 'orchestration',
      where: { publicId: args.orchestrationPublicId },
    };
  }

  const run = await db.OrchestrationRun.findOne({ where, include });
  if (!run)
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_FOUND',
      `Run '${args.runPublicId}' not found.`
    );

  if (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled'
  ) {
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_CANCELLABLE',
      `Run '${args.runPublicId}' is already in terminal state '${run.status}'.`
    );
  }

  await run.update({ status: 'cancelled', completedAt: new Date() });

  return mapOrchestrationRun(
    run as InstanceType<typeof db.OrchestrationRun> & {
      orchestration: InstanceType<typeof db.Orchestration>;
      project: InstanceType<typeof db.Project>;
    }
  );
};

export const submitHumanInput = async (args: {
  runPublicId: string;
  orchestrationPublicId?: string;
  projectIds?: number[];
  nodeId: string;
  output: Record<string, unknown>;
}): Promise<MappedOrchestrationRun> => {
  log('submitHumanInput %o', {
    runPublicId: args.runPublicId,
    nodeId: args.nodeId,
  });

  const where: Record<string, unknown> = { publicId: args.runPublicId };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const include: object[] = [
    { model: db.Project, as: 'project' },
    {
      model: db.Orchestration,
      as: 'orchestration',
      ...(args.orchestrationPublicId
        ? { where: { publicId: args.orchestrationPublicId } }
        : {}),
    },
  ];

  const run = await db.OrchestrationRun.findOne({ where, include });
  if (!run)
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_FOUND',
      `Run '${args.runPublicId}' not found.`
    );

  if (run.status !== 'paused')
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_PAUSED',
      `Run '${args.runPublicId}' is not paused (status: '${run.status}').`
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
  orchestrationPublicId?: string;
  projectIds?: number[];
}): Promise<MappedOrchestrationRun> => {
  log('resumeOrchestrationRun %o', { runPublicId: args.runPublicId });

  const where: Record<string, unknown> = { publicId: args.runPublicId };
  if (args.projectIds) where['projectId'] = args.projectIds;

  const include: object[] = [
    { model: db.Project, as: 'project' },
    {
      model: db.Orchestration,
      as: 'orchestration',
      ...(args.orchestrationPublicId
        ? { where: { publicId: args.orchestrationPublicId } }
        : {}),
    },
  ];

  const run = await db.OrchestrationRun.findOne({ where, include });
  if (!run)
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_FOUND',
      `Run '${args.runPublicId}' not found.`
    );

  if (run.status !== 'paused')
    throw new DomainError(
      'ORCHESTRATION_RUN_NOT_PAUSED',
      `Run '${args.runPublicId}' is not paused (status: '${run.status}').`
    );

  return resumeOrchestrationRunExecution({ run });
};
