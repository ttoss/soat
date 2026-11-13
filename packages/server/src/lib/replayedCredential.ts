import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { signIamToken } from './iamTokens';
import { issuingKeyProject } from './onBehalfOf';

const log = createDebug('soat:replayedCredential');

/** Outlasts a turn the request waits on; a later drive re-mints its own. */
const REPLAY_TTL_SECONDS = 3600;

/**
 * The `Authorization` work a request starts runs its own calls with: the
 * request's header, unless an `On-Behalf-Of` assertion capped the request.
 * Then the key held to that cap, as an IAM token, since replaying the raw key
 * would run the work on the key's full grant.
 */
export const replayedAuthHeader = (args: {
  ctx: {
    authUser?: AuthUser;
    headers?: Record<string, string | string[] | undefined>;
  };
}): string | undefined => {
  const { authUser } = args.ctx;
  if (authUser?.onBehalfOf) {
    const { apiKeyPublicId, bound } = authUser;
    const projectPublicId = issuingKeyProject(authUser);
    // Fails closed: work with no credential is refused at its first call.
    if (!apiKeyPublicId || !projectPublicId || !bound) return undefined;
    log('replayedAuthHeader: capped key=%s', apiKeyPublicId);
    const { token } = signIamToken({
      issuer: {
        publicId: authUser.publicId,
        role: authUser.role,
        apiKeyPublicId,
        projectPublicId,
      },
      bound,
      principal: authUser.onBehalfOfPrincipal,
      ttlSeconds: REPLAY_TTL_SECONDS,
    });
    return `Bearer ${token}`;
  }
  const authorization = args.ctx.headers?.authorization;
  return typeof authorization === 'string' ? authorization : undefined;
};
