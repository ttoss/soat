import type { Context } from '../Context';
import type { PolicyDocument } from '../lib/iam';
import { buildConsentPolicyFromScopeClaim } from '../lib/oauthConsent';

/**
 * An orchestration run-as token's boundary: the policies of the API key that
 * started the run, so the run can never reach further than that key. A
 * user-started run (no key claim) and a key with no policies of its own both
 * yield no boundary — the owner's policies, confined to the project.
 */
const resolveRunTokenBoundaryDocs = async (args: {
  apiKeyPublicId?: string;
  db: Context['db'];
}): Promise<PolicyDocument[] | undefined> => {
  if (!args.apiKeyPublicId) return undefined;
  const apiKey = await args.db.ApiKey.findOne({
    where: { publicId: args.apiKeyPublicId },
  });
  const policyIds = (apiKey?.policyIds as number[] | null) ?? [];
  if (policyIds.length === 0) return undefined;
  const policies = await args.db.Policy.findAll({ where: { id: policyIds } });
  return policies.map((policy) => {
    return policy.document as PolicyDocument;
  });
};

/**
 * Resolves the boundary PolicyDocuments for a project-scoped JWT credential:
 * - OAuth: the consented scope, rebuilt from the `scope` claim.
 * - Trigger run-as: the trigger's attached policy (if any); with none, the token
 *   inherits the creator's full policies (ceiling only), so no boundary is set.
 * - Orchestration run-as: when an API key started the run, that key's own
 *   policies, so a run can never reach further than the credential that started
 *   it; when a user started it (or the key carries no policies), no boundary —
 *   the owner's policies confined to the project, matching how each of those
 *   credentials evaluates on its own.
 * Returns `undefined` for an unscoped (plain user) JWT.
 *
 * Order matters: the OAuth branch is the fallback, so every other kind of
 * project-scoped token must be identified by its own marker claim first.
 * Falling through to it builds a consent policy from an absent `scope` claim,
 * which allows nothing at all.
 */
export const resolveScopedBoundaryDocs = async (args: {
  scopedProjectPublicId?: string;
  triggerPublicId?: string;
  runApiKeyPublicId?: string;
  isRunToken?: boolean;
  scopeClaim?: string;
  db: Context['db'];
}): Promise<PolicyDocument[] | undefined> => {
  if (!args.scopedProjectPublicId) return undefined;

  if (args.isRunToken) {
    return resolveRunTokenBoundaryDocs({
      apiKeyPublicId: args.runApiKeyPublicId,
      db: args.db,
    });
  }

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
