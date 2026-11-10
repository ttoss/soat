import type { db } from 'src/db';

import { DomainError } from '../errors';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { assertPoliciesAttachable } from './attachedPolicies';
import type { GetWriterPolicies } from './policyGrantCoverage';
import { assertSecretUseAllowed, secretRefIds } from './secretUse';

/**
 * A trigger's firings act under `policyIds`, so it carries at least one and
 * its writer must hold every one it adds.
 */
export const assertTriggerPoliciesHeld = async (args: {
  writerPolicies: GetWriterPolicies;
  projectId: number;
  policyIds?: string[];
  current: string[] | null;
}): Promise<void> => {
  if (args.policyIds === undefined) return;
  if (
    !Array.isArray(args.policyIds) ||
    args.policyIds.length === 0 ||
    !args.policyIds.every((id) => {
      return typeof id === 'string';
    })
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'policy_ids must name at least one policy: the grant every firing acts under.'
    );
  }
  await assertPoliciesAttachable({
    policyIds: args.policyIds,
    current: args.current,
    projectId: args.projectId,
    policyUse: args.writerPolicies,
  });
};

/**
 * What an update carries beyond its config: retargeting sends the stored
 * bag's secrets to the new target, and a new policy is a new grant.
 */
export const assertTriggerUpdateAuthority = async (params: {
  trigger: InstanceType<(typeof db)['Trigger']>;
  args: {
    toolContext?: Record<string, string> | null;
    policyIds?: string[];
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
  await assertTriggerPoliciesHeld({
    writerPolicies: args.writerPolicies,
    projectId: trigger.projectId as number,
    policyIds: args.policyIds,
    current: trigger.policyIds,
  });
};
