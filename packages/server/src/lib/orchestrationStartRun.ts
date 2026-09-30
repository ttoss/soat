import { db } from '../db';
import { orchestrations } from './orchestrationAccessor';
import type { RequiredAction } from './orchestrationNodeTypes';
import {
  type MappedOrchestrationRun,
  mapRequiredAction,
} from './orchestrations';

export const findOrchestrationForStartRun = async (args: {
  orchestrationPublicId: string;
  projectIds?: number[];
}): Promise<InstanceType<typeof db.Orchestration>> => {
  // `scopedWhere` makes an empty scope match nothing, which is what every
  // other module means by it — never "no restriction".
  const orchestration = await db.Orchestration.findOne({
    where: orchestrations.scopedWhere({
      id: args.orchestrationPublicId,
      projectIds: args.projectIds,
    }),
  });
  if (!orchestration) {
    throw orchestrations.notFound(args.orchestrationPublicId);
  }
  return orchestration;
};

/**
 * A run belongs to its orchestration's project, and its nodes resolve their
 * references there — never across the other projects a caller can reach.
 */
export const resolveStartRunProjectScope = (args: {
  orchestrationProjectId: number;
}) => {
  return {
    effectiveProjectId: args.orchestrationProjectId,
    effectiveProjectIds: [args.orchestrationProjectId],
  };
};

export const attachRequiredActionToRun = (args: {
  mapped: MappedOrchestrationRun;
  runStatus: MappedOrchestrationRun['status'];
  requiredAction: RequiredAction | null;
}): MappedOrchestrationRun => {
  const { mapped, runStatus, requiredAction } = args;
  if (runStatus !== 'awaiting_input' || !requiredAction) return mapped;

  mapped.required_action = mapRequiredAction(requiredAction);

  return mapped;
};
