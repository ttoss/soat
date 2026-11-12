import type { AuthUser, Context } from '../Context';
import type { PolicySets } from '../lib/iam';
import type { AssertedCall } from '../lib/onBehalfOf';
import { resolveGenerationIdentitySets } from '../lib/onBehalfOfIdentity';
import { narrowAuthority } from './authority';

/**
 * A request carrying a tool call's assertion runs as the key capped by the
 * authority that call was sent with and, for a generation's call, by that
 * generation's execution identity, so a tool server calling back acts no
 * further than the work it serves. Never widens.
 */
export const narrowToOnBehalfOf = (args: {
  authUser: AuthUser;
  asserted: AssertedCall;
  projectPublicId: string;
  db: Context['db'];
}): AuthUser => {
  const { authUser, asserted, projectPublicId } = args;
  const { principal, sets } = asserted.authority;
  const generationPublicId = asserted.onBehalfOf.generation_id;
  return {
    ...authUser,
    onBehalfOf: asserted.onBehalfOf,
    ...(principal ? { onBehalfOfPrincipal: principal } : {}),
    ...narrowAuthority({
      authority: authUser,
      projectPublicId,
      bound: async (): Promise<PolicySets> => {
        if (!generationPublicId) return sets;
        return [
          ...sets,
          ...(await resolveGenerationIdentitySets({
            generationPublicId,
            projectPublicId,
          })),
        ];
      },
      db: args.db,
    }),
  };
};
