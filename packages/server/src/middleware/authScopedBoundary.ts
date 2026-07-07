import type { Context } from '../Context';
import type { PolicyDocument } from '../lib/iam';
import { buildConsentPolicyFromScopeClaim } from '../lib/oauthConsent';

/**
 * Resolves the boundary PolicyDocuments for a project-scoped JWT credential:
 * - OAuth: the consented scope, rebuilt from the `scope` claim.
 * - Trigger run-as: the trigger's attached policy (if any); with none, the token
 *   inherits the creator's full policies (ceiling only), so no boundary is set.
 * Returns `undefined` for an unscoped (plain user) JWT.
 */
export const resolveScopedBoundaryDocs = async (args: {
  scopedProjectPublicId?: string;
  triggerPublicId?: string;
  scopeClaim?: string;
  db: Context['db'];
}): Promise<PolicyDocument[] | undefined> => {
  if (!args.scopedProjectPublicId) return undefined;

  if (args.triggerPublicId) {
    const trigger = await args.db.Trigger.findOne({
      where: { publicId: args.triggerPublicId },
    });
    const triggerPolicyId = trigger?.policyId as number | null | undefined;
    if (!triggerPolicyId) return undefined;
    const policy = await args.db.Policy.findOne({
      where: { id: triggerPolicyId },
    });
    return policy ? [policy.document as PolicyDocument] : undefined;
  }

  return [
    buildConsentPolicyFromScopeClaim({
      projectPublicId: args.scopedProjectPublicId,
      scopeClaim: args.scopeClaim,
    }),
  ];
};
