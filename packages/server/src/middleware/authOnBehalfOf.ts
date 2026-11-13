import type { AuthUser, Context } from '../Context';
import { callerPrincipal } from '../lib/authorizationDenial';
import type { AssertedCall } from '../lib/onBehalfOf';
import { resolveGenerationIdentitySets } from '../lib/onBehalfOfIdentity';
import type { LabeledPolicySets } from '../lib/permissions';
import { intersectBounds } from '../lib/principalBound';
import { narrowAuthority } from './authority';

/**
 * A request carrying a tool call's assertion runs as its credential (a key, or
 * an IAM token held to its bound) capped by the authority that call was sent with and, for a generation's call, by that
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
    // Work the request starts stores the cap with its principal.
    bound: intersectBounds({
      bounds: [
        ...(authUser.bound ? [authUser.bound] : []),
        { policySets: sets },
      ],
    }),
    ...(principal ? { onBehalfOfPrincipal: principal } : {}),
    ...narrowAuthority({
      authority: authUser,
      principal: callerPrincipal(authUser),
      projectPublicId,
      bound: async (): Promise<LabeledPolicySets> => {
        const cap = {
          principal: { type: 'on_behalf_of' as const, id: null },
          sets,
        };
        if (!generationPublicId) return [cap];
        return [
          cap,
          {
            principal: { type: 'generation', id: generationPublicId },
            sets: await resolveGenerationIdentitySets({
              generationPublicId,
              projectPublicId,
            }),
          },
        ];
      },
      db: args.db,
    }),
  };
};
