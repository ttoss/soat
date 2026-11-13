import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { authUserOfWork } from '../middleware/auth';
import { lockForTransaction } from './advisoryLocks';
import type { AgentAuthority } from './agentAuthority';
import {
  agentDenied,
  authorizationDenied,
  callerPrincipal,
} from './authorizationDenial';
import { buildSrn, evaluatePolicies } from './iam';
import { type OauthClientRow, resolveOauthClient } from './oauthClients';
import { type OauthConnectionRow, tokenColumns } from './oauthConnections';
import { requestTokens } from './oauthTokenEndpoint';
import { decryptValue } from './secrets';
import { toolAuthFailed } from './toolAuthConfig';
import type { WorkAuthority } from './workAuthority';

const log = createDebug('soat:oauth-connections');

export const USE_OAUTH_CONNECTION_ACTION =
  'oauth-connections:UseOauthConnection';

/** A token this close to expiry is refreshed before it is sent. */
const EXPIRY_MARGIN_MS = 60 * 1000;

const reconnect = (args: {
  message: string;
  clientId: string;
  actorId: string;
  connectionId?: string;
}) => {
  return new DomainError(
    'OAUTH_CONNECTION_REQUIRED',
    `${args.message} The actor must reconnect: start a new OAuth connection for this client and actor.`,
    {
      oauth_client_id: args.clientId,
      actor_id: args.actorId,
      ...(args.connectionId ? { oauth_connection_id: args.connectionId } : {}),
    }
  );
};

/**
 * Caller ∩ the agent's `policy_ids`: both must allow using this connection, so
 * neither the tool's author nor a broad agent can reach an actor's grant.
 */
const assertUseAllowed = async (args: {
  projectPublicId: string;
  resource: string;
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
}) => {
  const { agentAuthority } = args;
  if (
    agentAuthority?.policy &&
    !evaluatePolicies({
      policies: [agentAuthority.policy],
      action: USE_OAUTH_CONNECTION_ACTION,
      resource: args.resource,
    })
  ) {
    throw agentDenied({
      agentId: agentAuthority.agentId,
      action: USE_OAUTH_CONNECTION_ACTION,
      resource: args.resource,
    });
  }
  const caller = args.authority
    ? await authUserOfWork({ db, authority: args.authority })
    : undefined;
  const allowed = await caller?.isAllowed({
    projectPublicId: args.projectPublicId,
    action: USE_OAUTH_CONNECTION_ACTION,
    resource: args.resource,
  });
  if (!allowed) {
    throw authorizationDenied({
      principal: caller
        ? callerPrincipal(caller)
        : { type: 'caller', id: null },
      denied: [
        { action: USE_OAUTH_CONNECTION_ACTION, resource: args.resource },
      ],
    });
  }
};

const isFresh = (row: OauthConnectionRow, now: Date): boolean => {
  return (
    !!row.encryptedAccessToken &&
    (!row.accessTokenExpiresAt ||
      row.accessTokenExpiresAt.getTime() - now.getTime() > EXPIRY_MARGIN_MS)
  );
};

type RefreshOutcome =
  | { kind: 'token'; accessToken: string }
  | { kind: 'revoked'; message: string }
  | { kind: 'unavailable'; message: string };

/**
 * Refreshes under a per-connection lock: providers that rotate refresh tokens
 * (X) invalidate the old one on first use, so a second concurrent refresh
 * would disconnect the actor. A waiter re-reads and takes the winner's token.
 */
const refreshLocked = async (args: {
  connectionId: number;
  client: OauthClientRow;
  now: Date;
}): Promise<RefreshOutcome> => {
  return db.sequelize.transaction(async (transaction) => {
    await lockForTransaction({
      sequelize: db.sequelize,
      transaction,
      namespace: 'oauthConnectionRefresh',
      id: args.connectionId,
    });
    const row = (await db.OauthConnection.findByPk(args.connectionId, {
      transaction,
    })) as OauthConnectionRow | null;
    if (!row || row.status !== 'connected') {
      return { kind: 'revoked', message: 'The connection is not connected.' };
    }
    if (isFresh(row, args.now)) {
      return {
        kind: 'token',
        accessToken: decryptValue(row.encryptedAccessToken as string),
      };
    }
    if (!row.encryptedRefreshToken) {
      return {
        kind: 'revoked',
        message:
          'The access token expired and the provider issued no refresh token.',
      };
    }
    log('refreshLocked: refreshing connection=%s', row.publicId);
    const result = await requestTokens({
      client: await resolveOauthClient(args.client),
      params: {
        grant_type: 'refresh_token',
        refresh_token: decryptValue(row.encryptedRefreshToken),
      },
      now: args.now,
    });
    if (result.ok) {
      await row.update(
        { ...tokenColumns(result.tokens), error: null },
        { transaction }
      );
      return { kind: 'token', accessToken: result.tokens.accessToken };
    }
    const message = `The provider refused the refresh: ${result.error}.`;
    // A 4xx answer is the grant itself refused (`invalid_grant`); anything
    // else may pass, so the connection is kept.
    if (result.status === null || result.status >= 500) {
      return { kind: 'unavailable', message };
    }
    await row.update(
      {
        status: 'disconnected',
        error: { code: 'OAUTH_CONNECTION_REFRESH_FAILED', message },
      },
      { transaction }
    );
    return { kind: 'revoked', message };
  });
};

type ClientWithProject = OauthClientRow & { project: { publicId: string } };

/** The client in the tool's project and the connection the actor holds there. */
const loadConnection = async (args: {
  projectId: number;
  oauthClientId: string;
  actorId: string;
}): Promise<{ client: ClientWithProject; row: OauthConnectionRow | null }> => {
  const client = (await db.OauthProviderClient.findOne({
    where: { publicId: args.oauthClientId, projectId: args.projectId },
    include: [{ model: db.Project, as: 'project' }],
  })) as ClientWithProject | null;
  if (!client) {
    throw toolAuthFailed({
      message: `OAuth client '${args.oauthClientId}' not found in the tool's project.`,
      meta: {
        reason: 'oauth_client_not_found',
        oauth_client_id: args.oauthClientId,
      },
    });
  }
  const actor = await db.Actor.findOne({
    where: { publicId: args.actorId, projectId: args.projectId },
    attributes: ['id'],
  });
  const row = actor
    ? ((await db.OauthConnection.findOne({
        where: { oauthClientId: client.id, actorId: actor.id },
      })) as OauthConnectionRow | null)
    : null;
  return { client, row };
};

const tokenFrom = (args: {
  outcome: RefreshOutcome;
  ids: { clientId: string; actorId: string; connectionId?: string };
}): string => {
  const { outcome } = args;
  if (outcome.kind === 'token') return outcome.accessToken;
  if (outcome.kind === 'revoked') {
    throw reconnect({ ...args.ids, message: outcome.message });
  }
  throw toolAuthFailed({
    message: outcome.message,
    meta: { reason: 'provider_unavailable' },
  });
};

/**
 * The bearer an `oauth_connection` http tool sends: the access token of the
 * connection the turn's actor holds through `oauthClientId`.
 */
export const resolveOauthConnectionAccessToken = async (args: {
  projectId: number;
  oauthClientId: string;
  actorId?: string;
  authority: WorkAuthority | null;
  agentAuthority?: AgentAuthority;
  now?: Date;
}): Promise<string> => {
  const now = args.now ?? new Date();
  if (!args.actorId) {
    throw toolAuthFailed({
      message:
        'execute.auth oauth_connection needs an actor: run the tool in a generation or session for an actor, or call it with `actor_id`.',
      meta: { reason: 'actor_required', oauth_client_id: args.oauthClientId },
    });
  }
  const { client, row } = await loadConnection({
    projectId: args.projectId,
    oauthClientId: args.oauthClientId,
    actorId: args.actorId,
  });

  await assertUseAllowed({
    projectPublicId: client.project.publicId,
    resource: buildSrn({
      projectPublicId: client.project.publicId,
      resourceType: 'oauth_connection',
      resourceId: row?.publicId ?? '*',
    }),
    authority: args.authority,
    agentAuthority: args.agentAuthority,
  });

  const ids = {
    clientId: args.oauthClientId,
    actorId: args.actorId,
    connectionId: row?.publicId,
  };
  if (!row || row.status !== 'connected') {
    throw reconnect({
      ...ids,
      message: `Actor '${args.actorId}' has no connected OAuth connection for client '${args.oauthClientId}'.`,
    });
  }
  if (isFresh(row, now)) {
    return decryptValue(row.encryptedAccessToken as string);
  }
  log('resolveOauthConnectionAccessToken: refresh connection=%s', row.publicId);
  return tokenFrom({
    outcome: await refreshLocked({
      connectionId: row.id as number,
      client,
      now,
    }),
    ids,
  });
};
