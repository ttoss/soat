/**
 * Who a call on one share acts for.
 *
 * A share has two parties, and each authorizes in its own project: the
 * publisher against `srn:<publisher>:share:<id>`, a grantee against
 * `srn:<grantee>:share:<id>`. The acting project is the one the request names
 * (`project_id`), else the one a scoped credential is bound to; with neither,
 * or when it is the publisher's, the call is the publisher's.
 *
 * A grantee sees only a share addressed to it — by id or as a public share —
 * so any other share reads as absent rather than as forbidden.
 */
import type { Context } from 'src/Context';
import { findGranteeScope, shares } from 'src/lib/shares';

import { requireAuth } from './helpers';
import { authorizeResource, makeItemRouteAuthorizer } from './resourceAccess';

export type ShareParty =
  | { side: 'publisher' }
  | { side: 'grantee'; projectId: number; projectPublicId: string };

/** The routes only a publisher calls: suspend, resume, delete, acceptances. */
export const publisherShareAccess = makeItemRouteAuthorizer({
  findScope: shares.findScope,
  resourceType: 'share',
  param: 'share_id',
  label: 'Share',
});

export const authorizeShareParty = async (args: {
  ctx: Context;
  action: string;
  onDenied: 'hide' | 'refuse';
  /** The `project_id` the request names, if any. */
  projectPublicId?: string;
}): Promise<ShareParty> => {
  const { ctx } = args;
  requireAuth(ctx);
  const shareId = ctx.params.share_id;
  const publisherScope = await shares.findScope({ id: shareId });
  const acting =
    args.projectPublicId ??
    ctx.authUser.apiKeyProjectPublicId ??
    ctx.authUser.oauthProjectPublicId;

  const authorize = (scope: Awaited<ReturnType<typeof findGranteeScope>>) => {
    return authorizeResource({
      ctx,
      scope,
      resourceType: 'share',
      resourceId: shareId,
      action: args.action,
      onDenied: args.onDenied,
      label: 'Share',
    });
  };

  if (!publisherScope || !acting || acting === publisherScope.projectPublicId) {
    await authorize(publisherScope);
    return { side: 'publisher' };
  }

  const access = await authorize(
    await findGranteeScope({ shareId, projectPublicId: acting })
  );
  return {
    side: 'grantee',
    projectId: access.projectIds[0],
    projectPublicId: access.projectPublicId,
  };
};
