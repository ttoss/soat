import crypto from 'node:crypto';

import createDebug from 'debug';
import { db } from 'src/db';
import { paginatedList } from 'src/lib/pagination';
import { makeResourceAccessor } from 'src/lib/resourceAccessor';

import { DomainError } from '../errors';
import type { ResourceIncludes } from './modelIncludes';
import {
  isHttpUrl,
  type OauthClientRow,
  oauthClients,
  resolveOauthClient,
} from './oauthClients';
import { revokeToken, type TokenSet } from './oauthTokenEndpoint';
import { decryptValue, encryptValue } from './secrets';

const log = createDebug('soat:oauth-connections');

const STATE_TTL_MS = 10 * 60 * 1000;

export type OauthConnectionRow = InstanceType<
  (typeof db)['OauthConnection']
> & {
  project?: InstanceType<(typeof db)['Project']>;
  oauthClient?: OauthClientRow;
  actor?: InstanceType<(typeof db)['Actor']>;
};

export const connectionIncludes = (): ResourceIncludes => {
  return [
    { model: db.Project, as: 'project' },
    {
      model: db.OauthProviderClient,
      as: 'oauthClient',
      include: [{ model: db.Project, as: 'project' }],
    },
    { model: db.Actor, as: 'actor' },
  ];
};

export const oauthConnections = makeResourceAccessor<OauthConnectionRow>({
  model: () => {
    return db.OauthConnection;
  },
  includes: connectionIncludes,
  label: 'OAuth connection',
});

export const mapOauthConnection = (row: OauthConnectionRow) => {
  return {
    id: row.publicId,
    project_id: row.project?.publicId,
    oauth_client_id: row.oauthClient?.publicId,
    actor_id: row.actor?.publicId,
    status: row.status,
    scopes: row.grantedScopes ?? [],
    expires_at: row.accessTokenExpiresAt,
    connected_at: row.connectedAt,
    error: row.error,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

export const hashState = (state: string): string => {
  return crypto.createHash('sha256').update(state).digest('hex');
};

/** The ciphertext columns for a token set; a missing refresh token is kept. */
export const tokenColumns = (tokens: TokenSet) => {
  return {
    encryptedAccessToken: encryptValue(tokens.accessToken),
    ...(tokens.refreshToken
      ? { encryptedRefreshToken: encryptValue(tokens.refreshToken) }
      : {}),
    accessTokenExpiresAt: tokens.expiresAt,
  };
};

const defaultRedirectUri = (): string | null => {
  const base = process.env.SOAT_BASE_URL;
  return base
    ? `${base.replace(/\/+$/, '')}/api/v1/oauth-connections/callback`
    : null;
};

const buildAuthorizeUrl = (args: {
  client: OauthClientRow;
  redirectUri: string;
  state: string;
  codeVerifier: string | null;
}): string => {
  const url = new URL(args.client.authorizeUrl);
  for (const [name, value] of Object.entries(
    args.client.authorizeParams ?? {}
  )) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.client.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  if (args.client.scopes.length > 0) {
    url.searchParams.set('scope', args.client.scopes.join(' '));
  }
  url.searchParams.set('state', args.state);
  if (args.codeVerifier) {
    url.searchParams.set(
      'code_challenge',
      crypto.createHash('sha256').update(args.codeVerifier).digest('base64url')
    );
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
};

/** The project a client lives in, for the route to authorize against. */
export const findOauthClientScope = async (args: { id: string }) => {
  const scope = await oauthClients.findScope({ id: args.id });
  if (!scope) {
    throw new DomainError(
      'OAUTH_CLIENT_NOT_FOUND',
      `OAuth client '${args.id}' not found.`
    );
  }
  return scope;
};

const loadStartTargets = async (args: {
  oauthClientId: string;
  actorId: string;
  returnUrl?: string;
}) => {
  if (args.returnUrl !== undefined && !isHttpUrl(args.returnUrl)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'return_url must be an http(s) URL.'
    );
  }
  const client = await oauthClients.getByPublicId({
    id: args.oauthClientId,
    errorCode: 'OAUTH_CLIENT_NOT_FOUND',
  });
  const actor = await db.Actor.findOne({
    where: { publicId: args.actorId, projectId: client.projectId },
  });
  if (!actor) {
    throw new DomainError(
      'ACTOR_NOT_FOUND',
      `Actor '${args.actorId}' not found.`
    );
  }
  const redirectUri = client.redirectUri ?? defaultRedirectUri();
  if (!redirectUri) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'The OAuth client has no redirect_uri and SOAT_BASE_URL is not set, so there is no callback URL to send the provider.'
    );
  }
  return { client, actorRowId: actor.id as number, redirectUri };
};

/** A fresh single-use `state` and PKCE verifier, and the columns that hold them. */
const newPendingAuthorization = (args: {
  pkce: boolean;
  redirectUri: string;
  returnUrl?: string;
  now: Date;
}) => {
  const state = crypto.randomBytes(32).toString('base64url');
  const codeVerifier = args.pkce
    ? crypto.randomBytes(48).toString('base64url')
    : null;
  return {
    state,
    codeVerifier,
    columns: {
      stateHash: hashState(state),
      stateExpiresAt: new Date(args.now.getTime() + STATE_TTL_MS),
      encryptedCodeVerifier: codeVerifier ? encryptValue(codeVerifier) : null,
      redirectUri: args.redirectUri,
      returnUrl: args.returnUrl ?? null,
    },
  };
};

export const startOauthConnection = async (args: {
  oauthClientId: string;
  actorId: string;
  returnUrl?: string;
  now?: Date;
}) => {
  log(
    'startOauthConnection: client=%s actor=%s',
    args.oauthClientId,
    args.actorId
  );
  const { client, actorRowId, redirectUri } = await loadStartTargets(args);
  const pending = newPendingAuthorization({
    pkce: client.pkce,
    redirectUri,
    returnUrl: args.returnUrl,
    now: args.now ?? new Date(),
  });

  const existing = await db.OauthConnection.findOne({
    where: { oauthClientId: client.id, actorId: actorRowId },
  });
  if (existing) await existing.update(pending.columns);
  const row =
    existing ??
    (await db.OauthConnection.create({
      projectId: client.projectId,
      oauthClientId: client.id,
      actorId: actorRowId,
      status: 'pending',
      ...pending.columns,
    }));
  log(
    'startOauthConnection: connection=%s created=%s',
    row.publicId,
    !existing
  );

  return {
    created: !existing,
    connection: {
      ...mapOauthConnection(await oauthConnections.reload(row)),
      authorize_url: buildAuthorizeUrl({
        client,
        redirectUri,
        state: pending.state,
        codeVerifier: pending.codeVerifier,
      }),
      authorize_url_expires_at: pending.columns.stateExpiresAt,
    },
  };
};

/** `undefined`: no filter; `null`: a filter that matches nothing here. */
const resolveFilterId = async (args: {
  find: (where: Record<string, unknown>) => Promise<{ id?: unknown } | null>;
  publicId?: string;
  projectIds: number[];
}): Promise<number | null | undefined> => {
  if (!args.publicId) return undefined;
  const row = await args.find({
    publicId: args.publicId,
    projectId: args.projectIds,
  });
  return row ? Number(row.id) : null;
};

export const listOauthConnections = async (args: {
  projectIds: number[];
  actorId?: string;
  oauthClientId?: string;
  limit?: number;
  cursor?: string;
}) => {
  const actorId = await resolveFilterId({
    find: (where) => {
      return db.Actor.findOne({ where, attributes: ['id'] });
    },
    publicId: args.actorId,
    projectIds: args.projectIds,
  });
  const oauthClientId = await resolveFilterId({
    find: (where) => {
      return db.OauthProviderClient.findOne({ where, attributes: ['id'] });
    },
    publicId: args.oauthClientId,
    projectIds: args.projectIds,
  });
  const nothing = actorId === null || oauthClientId === null;
  return paginatedList({
    limit: args.limit,
    cursor: args.cursor,
    filters: {
      projectIds: args.projectIds,
      actorId: args.actorId,
      oauthClientId: args.oauthClientId,
    },
    where: {
      projectId: nothing ? [] : args.projectIds,
      ...(actorId ? { actorId } : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
    },
    order: [['createdAt', 'ASC']],
    query: ({ where, limit, order }) => {
      return db.OauthConnection.findAll({
        where,
        include: connectionIncludes(),
        order,
        limit,
      }) as Promise<OauthConnectionRow[]>;
    },
    map: mapOauthConnection,
  });
};

export const getOauthConnection = async (args: { id: string }) => {
  return mapOauthConnection(
    await oauthConnections.getByPublicId({ id: args.id })
  );
};

export const deleteOauthConnection = async (args: { id: string }) => {
  const row = await oauthConnections.getByPublicId({ id: args.id });
  const stored = row.encryptedRefreshToken ?? row.encryptedAccessToken;
  if (stored && row.oauthClient) {
    await revokeToken({
      client: await resolveOauthClient(row.oauthClient),
      token: decryptValue(stored),
      tokenTypeHint: row.encryptedRefreshToken
        ? 'refresh_token'
        : 'access_token',
    });
  }
  log('deleteOauthConnection: connection=%s', row.publicId);
  await row.destroy();
};
