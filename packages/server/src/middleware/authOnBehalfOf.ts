import type { AuthUser, Context } from '../Context';
import type { PolicySets } from '../lib/iam';
import { resolveGenerationIdentitySets } from '../lib/onBehalfOfIdentity';
import { createPolicySetsIsAllowed } from '../lib/permissions';
import { createApiKeyResolveProjectIds } from './authProjectResolvers';

/**
 * A request carrying the assertion of a generation's tool call runs as the key
 * capped by that generation's execution identity, so a tool server calling
 * back acts no further than a `builtin` call of the same turn. Never widens.
 */
export const narrowToOnBehalfOf = (args: {
  authUser: AuthUser;
  db: Context['db'];
}): AuthUser => {
  const { authUser } = args;
  const generationPublicId = authUser.onBehalfOf?.generation_id;
  const projectPublicId = authUser.apiKeyProjectPublicId;
  if (!generationPublicId || !projectPublicId) return authUser;

  let identity: Promise<PolicySets> | undefined;
  const getSets = () => {
    identity ??= resolveGenerationIdentitySets({
      generationPublicId,
      projectPublicId,
    });
    return identity;
  };
  const identityIsAllowed = createPolicySetsIsAllowed({
    projectPublicId,
    getSets,
  });

  const isAllowed: AuthUser['isAllowed'] = async (reqArgs) => {
    return (
      (await authUser.isAllowed(reqArgs)) && (await identityIsAllowed(reqArgs))
    );
  };

  return {
    ...authUser,
    isAllowed,
    resolveProjectIds: createApiKeyResolveProjectIds({
      apiKeyProjectPublicId: projectPublicId,
      apiKeyIsAllowed: isAllowed,
      db: args.db,
    }),
    getPolicies: async (reqProjectPublicId) => {
      const own = await authUser.getPolicies(reqProjectPublicId);
      if (own.length === 0) return own;
      return [...own, ...(await getSets())];
    },
  };
};
