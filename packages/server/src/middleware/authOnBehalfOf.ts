import type { AuthUser } from '../Context';
import { issuingKeyProject, requestOnBehalfOf } from '../lib/onBehalfOf';
import { resolveGenerationIdentitySets } from '../lib/onBehalfOfIdentity';
import { intersectBounds } from '../lib/principalBound';
import type { Authority, AuthorityTerms, Cap } from './authority';

/**
 * A credential resolved before its authority is built: who it is, and the
 * terms its authority is built from.
 */
export type ResolvedCredential = {
  authUser: Omit<AuthUser, keyof Authority>;
  terms: AuthorityTerms;
};

/**
 * A request carrying a tool call's assertion runs as its credential (a key, or
 * an IAM token held to its bound), pinned to the key's project and capped by
 * the authority that call was sent with and, for a generation's call, by that
 * generation's execution identity, so a tool server calling back acts no
 * further than the work it serves.
 */
export const withOnBehalfOf = (args: {
  headers: Record<string, string | string[] | undefined>;
  resolved: ResolvedCredential;
}): ResolvedCredential => {
  const { authUser, terms } = args.resolved;
  const projectPublicId = issuingKeyProject(authUser);
  const asserted = requestOnBehalfOf({
    headers: args.headers,
    keyProjectPublicId: projectPublicId,
  });
  if (!asserted || !projectPublicId) return args.resolved;
  const { principal, sets } = asserted.authority;
  const generationPublicId = asserted.onBehalfOf.generation_id;
  const caps: Cap[] = [
    {
      principal: { type: 'on_behalf_of', id: null },
      kind: 'other',
      bound: {
        allows: 'policies',
        load: async () => {
          return sets;
        },
      },
    },
    ...(generationPublicId
      ? [
          {
            principal: { type: 'generation' as const, id: generationPublicId },
            kind: 'other' as const,
            bound: {
              allows: 'policies' as const,
              load: () => {
                return resolveGenerationIdentitySets({
                  generationPublicId,
                  projectPublicId,
                });
              },
            },
          },
        ]
      : []),
  ];
  return {
    authUser: {
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
    },
    terms: {
      pinned: projectPublicId,
      grant: terms.grant,
      caps: [...terms.caps, ...caps],
    },
  };
};
