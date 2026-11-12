import type { Context } from '../Context';
import {
  resolveAttachedPolicySet,
  resolveBoundSet,
} from '../lib/attachedPolicies';
import type { PolicyDocument, PolicySets } from '../lib/iam';
import { buildConsentPolicyFromScopeClaim } from '../lib/oauthConsent';
import { resolvePolicySets } from '../lib/permissions';
import type { PrincipalBound } from '../lib/principalBound';

/**
 * An orchestration run-as token's boundary: the policies of the API key that
 * started the run, so the run can never reach further than that key. A
 * user-started run (no key claim) and a key with no policies of its own both
 * yield no boundary — the owner's policies, confined to the project. A key
 * deleted since the token was minted yields an allow-nothing boundary.
 */
const resolveRunTokenBoundaryDocs = async (args: {
  apiKeyPublicId?: string;
  db: Context['db'];
}): Promise<PolicyDocument[] | undefined> => {
  if (!args.apiKeyPublicId) return undefined;
  const apiKey = await args.db.ApiKey.findOne({
    where: { publicId: args.apiKeyPublicId },
  });
  if (!apiKey) return [];
  const policyIds = (apiKey.policyIds as number[] | null) ?? [];
  if (policyIds.length === 0) return undefined;
  const policies = await args.db.Policy.findAll({ where: { id: policyIds } });
  return policies.map((policy) => {
    return policy.document as PolicyDocument;
  });
};

/**
 * The boundary PolicyDocuments of a project-scoped JWT credential:
 * - OAuth: the consented scope, rebuilt from the `scope` claim.
 * - Run and IAM token: the acting API key's own policies, so the credential
 *   never reaches further than that key; when a user started the run, none.
 */
export const resolveScopedBoundaryDocs = async (args: {
  scopedProjectPublicId: string;
  credential:
    | { typ: 'oauth'; scopeClaim?: string }
    | { typ: 'run' | 'iam'; apiKeyPublicId?: string };
  db: Context['db'];
}): Promise<PolicyDocument[] | undefined> => {
  const { credential } = args;
  if (credential.typ === 'oauth') {
    return [
      buildConsentPolicyFromScopeClaim({
        projectPublicId: args.scopedProjectPublicId,
        scopeClaim: credential.scopeClaim,
      }),
    ];
  }
  return resolveRunTokenBoundaryDocs({
    apiKeyPublicId: credential.apiKeyPublicId,
    db: args.db,
  });
};

/**
 * The policy sets a trigger run-as token must each satisfy: the trigger's
 * `policy_ids`, and, for a manual fire, the caller's own grant as its
 * credential narrows it. A trigger deleted since the token was minted, or one
 * with no policy, allows nothing.
 */
export const resolveTriggerPolicySets = async (args: {
  triggerPublicId: string;
  projectPublicId: string;
  caller?: {
    role: 'admin' | 'user';
    userPolicyIds: number[];
    apiKeyPublicId?: string;
    oauthScope?: string;
    bound?: PrincipalBound;
  };
  db: Context['db'];
}): Promise<PolicySets> => {
  const trigger = await args.db.Trigger.findOne({
    where: { publicId: args.triggerPublicId },
  });
  const triggerDocs = await resolveAttachedPolicySet({
    policyIds: trigger?.policyIds ?? null,
  });
  if (!args.caller) return [triggerDocs];
  const callerSets = await resolvePolicySets({
    userRole: args.caller.role,
    userPolicyIds: args.caller.userPolicyIds,
    apiKeyPolicyIds: [],
    boundaryPolicyDocs:
      args.caller.oauthScope !== undefined
        ? [
            buildConsentPolicyFromScopeClaim({
              projectPublicId: args.projectPublicId,
              scopeClaim: args.caller.oauthScope,
            }),
          ]
        : await resolveRunTokenBoundaryDocs({
            apiKeyPublicId: args.caller.apiKeyPublicId,
            db: args.db,
          }),
    db: args.db,
  });
  const boundSets = args.caller.bound
    ? [await resolveBoundSet(args.caller.bound)]
    : [];
  return [...callerSets, ...boundSets, triggerDocs];
};
