import type { AuthUser } from '../Context';
import { issuingKeyProject, requestOnBehalfOf } from '../lib/onBehalfOf';
import type { Authority } from './authority';

/** A credential resolved before its authority is built: who it is, and its stated terms. */
export type ResolvedCredential = {
  authUser: Omit<AuthUser, keyof Authority>;
};

/**
 * A request carrying a tool call's assertion runs as its credential (a key, or
 * an IAM token held to its bound), pinned to the key's project and capped by
 * the authority of the work that call was sent for, which the assertion
 * carries sealed: a tool server calling back acts no further than that work.
 */
export const withOnBehalfOf = (args: {
  headers: Record<string, string | string[] | undefined>;
  resolved: ResolvedCredential;
}): ResolvedCredential => {
  const { authUser } = args.resolved;
  const projectPublicId = issuingKeyProject(authUser);
  const asserted = requestOnBehalfOf({
    headers: args.headers,
    keyProjectPublicId: projectPublicId,
  });
  if (!asserted || !projectPublicId) return args.resolved;
  const { principal, sets } = asserted.authority;
  return {
    authUser: {
      ...authUser,
      onBehalfOf: asserted.onBehalfOf,
      ...(principal ? { onBehalfOfPrincipal: principal } : {}),
      terms: {
        ...authUser.terms,
        pinned: projectPublicId,
        caps: [
          ...authUser.terms.caps,
          {
            kind: 'bound',
            bound: { policySets: sets },
            by: { type: 'on_behalf_of', id: null },
          },
        ],
      },
    },
  };
};
