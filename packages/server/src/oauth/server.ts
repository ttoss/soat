/**
 * OAuth 2.1 Authorization Server for SOAT, built on `@ttoss/http-server-auth`
 * and `@ttoss/auth-core`. SOAT issues its own first-party tokens so MCP clients
 * (Claude, Cursor, VS Code) can discover, register, and run the full
 * authorize/PKCE flow against this server.
 *
 * ttoss owns the protocol mechanics (discovery, DCR, PKCE, token grants); SOAT
 * owns the hooks below — token minting and consent — while the consent UI
 * itself lives in the app (SPA) at /app/oauth/consent. /authorize redirects
 * there; the app records the decision via POST /api/v1/oauth/consent.
 */
import type {
  AuthCodeStore,
  ClientStore,
  OAuthClient,
  RefreshTokenStore,
  StoredAuthorizationCode,
  StoredRefreshToken,
} from '@ttoss/auth-core';
import { createRefreshRotation, signJwt, verifyJwt } from '@ttoss/auth-core';
import { oauthServer } from '@ttoss/http-server-auth';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:oauth');

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret';
const PORT = process.env.PORT ?? '5047';
export const ISSUER = process.env.SOAT_BASE_URL ?? `http://localhost:${PORT}`;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
const CONSENT_SESSION_TTL_MS = 10 * 60 * 1000; // 10min
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Synthetic scope prefix used to carry the granted project through the flow. */
export const PROJECT_SCOPE_PREFIX = 'prj:';

/** Stores a consent grant keyed by PKCE code_challenge (single-use, 10-min TTL). */
export const saveConsentGrant = async (args: {
  codeChallenge: string;
  clientId: string;
  subject: string;
  scopes: string[];
}): Promise<void> => {
  await db.OauthConsentGrant.upsert({
    codeChallenge: args.codeChallenge,
    clientId: args.clientId,
    subject: args.subject,
    scopes: args.scopes.join(' '),
    expiresAt: new Date(Date.now() + CONSENT_SESSION_TTL_MS),
  });
};

// Postgres-backed client store (replaces createMemoryClientStore)
const clientStore: ClientStore = {
  get: async (clientId: string): Promise<OAuthClient | undefined> => {
    const row = await db.OauthClient.findOne({ where: { clientId } });
    return row ? (row.clientData as OAuthClient) : undefined;
  },
  register: async (client: OAuthClient): Promise<void> => {
    await db.OauthClient.upsert({
      clientId: client.client_id,
      clientData: client,
    });
  },
};

// Postgres-backed auth code store (replaces createMemoryAuthCodeStore)
const authCodeStore: AuthCodeStore = {
  save: async (code: StoredAuthorizationCode): Promise<void> => {
    await db.OauthAuthCode.create({
      code: code.code,
      codeData: code,
      expiresAt: new Date(code.expiresAt),
    });
  },
  get: async (code: string): Promise<StoredAuthorizationCode | undefined> => {
    const row = await db.OauthAuthCode.findOne({
      where: { code, expiresAt: { [Op.gt]: new Date() } },
    });
    return row ? (row.codeData as StoredAuthorizationCode) : undefined;
  },
  delete: async (code: string): Promise<void> => {
    await db.OauthAuthCode.destroy({ where: { code } });
  },
};

// Postgres-backed refresh token store
const refreshTokenStore: RefreshTokenStore = {
  save: async (token: StoredRefreshToken): Promise<void> => {
    await db.OauthRefreshToken.upsert({
      tokenHash: token.tokenHash,
      clientId: token.clientId,
      subject: token.subject,
      scopes: token.scopes.join(' '),
      expiresAt: new Date(token.expiresAt),
      consumedAt: token.consumedAt != null ? new Date(token.consumedAt) : null,
    });
  },
  get: async (tokenHash: string): Promise<StoredRefreshToken | undefined> => {
    const row = await db.OauthRefreshToken.findOne({ where: { tokenHash } });
    if (!row) return undefined;
    return {
      tokenHash: row.tokenHash,
      clientId: row.clientId,
      subject: row.subject,
      scopes: row.scopes.split(' ').filter(Boolean),
      expiresAt: row.expiresAt.getTime(),
      consumedAt: row.consumedAt != null ? row.consumedAt.getTime() : undefined,
    };
  },
  delete: async (tokenHash: string): Promise<void> => {
    await db.OauthRefreshToken.destroy({ where: { tokenHash } });
  },
  deleteByOwner: async ({
    clientId,
    subject,
  }: {
    clientId: string;
    subject: string;
  }): Promise<void> => {
    await db.OauthRefreshToken.destroy({ where: { clientId, subject } });
  },
};

const refreshRotation = createRefreshRotation({
  store: refreshTokenStore,
  refreshTokenTtl: REFRESH_TOKEN_TTL_SECONDS,
});

/**
 * The OAuth authorization server router. Mount its routes on the app:
 * `app.use(oauthAuthorizationServer.routes())`.
 */
export const oauthAuthorizationServer = oauthServer({
  issuer: ISSUER,
  resource: ISSUER,
  clientStore,
  authCodeStore,
  scopesSupported: ['mcp:access'],
  issueTokens: async ({ subject, scopes, client }) => {
    const project = scopes
      .find((s) => {
        return s.startsWith(PROJECT_SCOPE_PREFIX);
      })
      ?.slice(PROJECT_SCOPE_PREFIX.length);

    const user = await db.User.findOne({ where: { publicId: subject } });
    const role = user?.role ?? 'user';

    log(
      'issueTokens: subject=%s project=%s scopes=%d role=%s',
      subject,
      project,
      scopes.length,
      role
    );

    const refreshToken = await refreshRotation.issue({
      client,
      subject,
      scopes,
    });

    return {
      accessToken: signJwt({
        payload: {
          sub: subject,
          publicId: subject,
          role,
          scope: scopes.join(' '),
          prj: project,
        },
        secret: JWT_SECRET,
        expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      }),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
    };
  },
  onRefreshToken: refreshRotation.onRefreshToken,
  onAuthorize: async ({ request }) => {
    // Atomically consume the consent grant: lock the row, verify it belongs to
    // this client, then destroy it in the same transaction to prevent double-use.
    const grant = await db.sequelize.transaction(async (t) => {
      const row = await db.OauthConsentGrant.findOne({
        where: {
          codeChallenge: request.codeChallenge,
          expiresAt: { [Op.gt]: new Date() },
        },
        lock: true,
        transaction: t,
      });
      if (!row || row.clientId !== request.clientId) return null;
      await row.destroy({ transaction: t });
      return row;
    });

    if (grant) {
      log('onAuthorize: approved subject=%s', grant.subject);
      return {
        approved: true as const,
        subject: grant.subject,
        scopes: grant.scopes.split(' ').filter(Boolean),
      };
    }

    log('onAuthorize: no consent — redirecting to consent screen');
    const params = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: 'code',
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallengeMethod,
      scope: request.scopes.join(' '),
    });
    if (request.state) params.set('state', request.state);
    return {
      approved: false as const,
      redirect: `/app/oauth/consent?${params.toString()}`,
    };
  },
});

/** Verifies a SOAT-issued OAuth access token. Returns the payload or null. */
export const verifyOauthAccessToken = (token: string) => {
  return verifyJwt({ token, secret: JWT_SECRET });
};
