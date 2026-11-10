import type { db } from 'src/db';

import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import {
  assertWriterHoldsPolicies,
  type GetWriterPolicies,
} from './policyGrantCoverage';
import { assertSecretUseAllowed, secretRefIds } from './secretUse';

/** The trigger's firings act under `policyId`, so its writer must hold it. */
export const assertTriggerPolicyHeld = (args: {
  writerPolicies: GetWriterPolicies;
  projectId: number;
  policyId?: number | null;
}): Promise<void> => {
  return assertWriterHoldsPolicies({
    getPolicies: args.writerPolicies,
    projectId: args.projectId,
    policyIds: args.policyId ? [args.policyId] : [],
  });
};

/**
 * What an update carries beyond its config: retargeting sends the stored
 * bag's secrets to the new target, and a new `policyId` is a new grant.
 */
export const assertTriggerUpdateAuthority = async (params: {
  trigger: InstanceType<(typeof db)['Trigger']>;
  args: {
    toolContext?: Record<string, string> | null;
    policyId?: number | null;
    isAllowed: IsAllowedFn;
    writerPolicies: GetWriterPolicies;
  };
  targetChanged: boolean;
}): Promise<void> => {
  const { trigger, args } = params;
  // A new bag in the same write is checked by its own ingress.
  if (params.targetChanged && args.toolContext === undefined) {
    await assertSecretUseAllowed({
      secretIds: secretRefIds(trigger.toolContext),
      projectId: trigger.projectId as number,
      isAllowed: args.isAllowed,
    });
  }
  await assertTriggerPolicyHeld({
    writerPolicies: args.writerPolicies,
    projectId: trigger.projectId as number,
    policyId: args.policyId,
  });
};
