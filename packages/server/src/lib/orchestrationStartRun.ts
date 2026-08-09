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
  // Lean lookup: the start path reads the row's own columns only.
  //
  // This used to skip the `projectId` filter whenever `projectIds` was an empty
  // array, which read as "no scope restriction" — the opposite of what every
  // other module means by it. `scopedWhere` makes an empty scope match nothing.
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

  mapped.required_action = mapRequiredAction(requiredAction);

  return mapped;
};
