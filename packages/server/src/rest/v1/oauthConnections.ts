import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { completeOauthConnection } from 'src/lib/oauthConnectionCallback';
import {
  deleteOauthConnection,
  findOauthClientScope,
  getOauthConnection,
  listOauthConnections,
  oauthConnections,
  startOauthConnection,
} from 'src/lib/oauthConnections';

import { parsePagination, requireAuth, resolveWriteProjectId } from './helpers';
import { resolveListScope } from './listScope';
import { makeItemRouteAuthorizer } from './resourceAccess';

const oauthConnectionsRouter = new Router<Context>();

const oauthConnectionAccess = makeItemRouteAuthorizer({
  findScope: oauthConnections.findScope,
  resourceType: 'oauth_connection',
  param: 'oauth_connection_id',
  label: 'OAuth connection',
});

const queryString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value ? value : undefined;
};

oauthConnectionsRouter.get('/oauth-connections', async (ctx: Context) => {
  requireAuth(ctx);
  const { projectIds } = await resolveListScope({
    ctx,
    action: 'oauth-connections:ListOauthConnections',
    resourceType: 'oauth_connection',
    projectSelector: 'optional',
  });
  ctx.body = await listOauthConnections({
    projectIds,
    actorId: queryString(ctx.query.actor_id),
    oauthClientId: queryString(ctx.query.oauth_client_id),
    ...parsePagination(ctx),
  });
});

oauthConnectionsRouter.post('/oauth-connections', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    oauth_client_id: string;
    actor_id: string;
    return_url?: string;
  };
  const scope = await findOauthClientScope({ id: body.oauth_client_id });
  await resolveWriteProjectId({
    ctx,
    projectPublicId: scope.projectPublicId,
    action: 'oauth-connections:CreateOauthConnection',
    resourceType: 'oauth_connection',
  });
  const started = await startOauthConnection({
    oauthClientId: body.oauth_client_id,
    actorId: body.actor_id,
    returnUrl: body.return_url,
  });
  ctx.status = started.created ? 201 : 200;
  ctx.body = started.connection;
});

// Registered before `/:oauth_connection_id`. Not IAM-gated: the single-use
// `state` is the credential.
oauthConnectionsRouter.get(
  '/oauth-connections/callback',
  async (ctx: Context) => {
    const outcome = await completeOauthConnection({
      state: queryString(ctx.query.state),
      code: queryString(ctx.query.code),
      error: queryString(ctx.query.error),
      errorDescription: queryString(ctx.query.error_description),
    });
    if (outcome.returnUrl) {
      const target = new URL(outcome.returnUrl);
      target.searchParams.set('oauth_connection_id', outcome.connection.id);
      target.searchParams.set(
        'status',
        outcome.failure ? 'failed' : outcome.connection.status
      );
      ctx.redirect(target.toString());
      return;
    }
    if (outcome.failure) throw outcome.failure;
    ctx.body = outcome.connection;
  }
);

oauthConnectionsRouter.get(
  '/oauth-connections/:oauth_connection_id',
  async (ctx: Context) => {
    await oauthConnectionAccess.authorizeRead({
      ctx,
      action: 'oauth-connections:GetOauthConnection',
    });
    ctx.body = await getOauthConnection({
      id: ctx.params.oauth_connection_id,
    });
  }
);

oauthConnectionsRouter.delete(
  '/oauth-connections/:oauth_connection_id',
  async (ctx: Context) => {
    await oauthConnectionAccess.authorizeWrite({
      ctx,
      action: 'oauth-connections:DeleteOauthConnection',
    });
    await deleteOauthConnection({ id: ctx.params.oauth_connection_id });
    ctx.status = 204;
  }
);

export { oauthConnectionsRouter };
