import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  createOauthClient,
  deleteOauthClient,
  getOauthClient,
  listOauthClients,
  type OauthClientInput,
  oauthClients,
  updateOauthClient,
} from 'src/lib/oauthClients';

import {
  parsePagination,
  requireAuth,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

const oauthClientsRouter = new Router<Context>();

const oauthClientAccess = makeItemRouteAuthorizer({
  findScope: oauthClients.findScope,
  resourceType: 'oauth_client',
  param: 'oauth_client_id',
  label: 'OAuth client',
});

type OauthClientBody = {
  project_id?: string;
  name?: string;
  authorize_url?: string;
  token_url?: string;
  revocation_url?: string | null;
  client_id?: string;
  client_secret?: string | null;
  scopes?: string[];
  pkce?: boolean;
  token_endpoint_auth_method?: string;
  redirect_uri?: string | null;
  authorize_params?: Record<string, string> | null;
};

const readInput = (body: OauthClientBody): OauthClientInput => {
  return {
    name: body.name,
    authorizeUrl: body.authorize_url,
    tokenUrl: body.token_url,
    revocationUrl: body.revocation_url,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    scopes: body.scopes,
    pkce: body.pkce,
    tokenEndpointAuthMethod: body.token_endpoint_auth_method,
    redirectUri: body.redirect_uri,
    authorizeParams: body.authorize_params,
  };
};

oauthClientsRouter.get('/oauth-clients', async (ctx: Context) => {
  requireAuth(ctx);
  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'oauth-clients:ListOauthClients',
    resourceType: 'oauth_client',
  });
  ctx.body = await listOauthClients({
    projectIds: projectIds ?? [],
    ...parsePagination(ctx),
  });
});

oauthClientsRouter.get(
  '/oauth-clients/:oauth_client_id',
  async (ctx: Context) => {
    await oauthClientAccess.authorizeRead({
      ctx,
      action: 'oauth-clients:GetOauthClient',
    });
    ctx.body = await getOauthClient({ id: ctx.params.oauth_client_id });
  }
);

oauthClientsRouter.post('/oauth-clients', async (ctx: Context) => {
  requireAuth(ctx);
  // The required fields are guaranteed by the strict-field middleware.
  const body = ctx.request.body as OauthClientBody &
    Required<
      Pick<
        OauthClientBody,
        'name' | 'authorize_url' | 'token_url' | 'client_id' | 'scopes'
      >
    >;
  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'oauth-clients:CreateOauthClient',
    resourceType: 'oauth_client',
  });
  ctx.status = 201;
  ctx.body = await createOauthClient({
    projectId: Number(projectId),
    input: {
      ...readInput(body),
      name: body.name,
      authorizeUrl: body.authorize_url,
      tokenUrl: body.token_url,
      clientId: body.client_id,
      scopes: body.scopes,
    },
    isAllowed: ctx.authUser.isAllowed,
  });
});

oauthClientsRouter.patch(
  '/oauth-clients/:oauth_client_id',
  async (ctx: Context) => {
    await oauthClientAccess.authorizeWrite({
      ctx,
      action: 'oauth-clients:UpdateOauthClient',
    });
    requireAuth(ctx);
    ctx.body = await updateOauthClient({
      id: ctx.params.oauth_client_id,
      input: readInput(ctx.request.body as OauthClientBody),
      isAllowed: ctx.authUser.isAllowed,
    });
  }
);

oauthClientsRouter.delete(
  '/oauth-clients/:oauth_client_id',
  async (ctx: Context) => {
    await oauthClientAccess.authorizeWrite({
      ctx,
      action: 'oauth-clients:DeleteOauthClient',
    });
    await deleteOauthClient({ id: ctx.params.oauth_client_id });
    ctx.status = 204;
  }
);

export { oauthClientsRouter };
