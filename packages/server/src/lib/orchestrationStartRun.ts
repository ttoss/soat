import { db } from '../db';
import { DomainError } from '../errors';
import type { RequiredAction } from './orchestrationExecutors';
import type { MappedOrchestrationRun } from './orchestrations';

export const findOrchestrationForStartRun = async (args: {
  orchestrationPublicId: string;
  projectIds?: number[];
}): Promise<InstanceType<typeof db.Orchestration>> => {
  const where: Record<string, unknown> = {
    publicId: args.orchestrationPublicId,
  };

  if (args.projectIds && args.projectIds.length > 0) {
    where['projectId'] = args.projectIds;
  }

  const orchestration = await db.Orchestration.findOne({ where });
  if (orchestration) return orchestration;

  throw new DomainError(
    'ORCHESTRATION_NOT_FOUND',
    `Orchestration '${args.orchestrationPublicId}' not found.`
  );
};

export const resolveStartRunProjectScope = (args: {
  projectId?: number;
  projectIds?: number[];
  orchestrationProjectId: number;
}) => {
  const effectiveProjectIds =
    args.projectIds && args.projectIds.length > 0
      ? args.projectIds
      : [args.orchestrationProjectId];

  return {
    effectiveProjectId: args.projectId ?? args.orchestrationProjectId,
    effectiveProjectIds,
  };
};

export const attachRequiredActionToRun = (args: {
  mapped: MappedOrchestrationRun;
  runStatus: MappedOrchestrationRun['status'];
  requiredAction: RequiredAction | null;
}): MappedOrchestrationRun => {
  const { mapped, runStatus, requiredAction } = args;
  if (runStatus !== 'awaiting_input' || !requiredAction) return mapped;

  (
    mapped as MappedOrchestrationRun & { requiredAction?: RequiredAction }
  ).requiredAction = requiredAction;

  return mapped;
};
