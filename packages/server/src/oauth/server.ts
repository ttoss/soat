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
  StoredAuthorizationCode,
} from '@ttoss/auth-core';
import { signJwt, verifyJwt } from '@ttoss/auth-core';
import { oauthServer } from '@ttoss/http-server-auth';
import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';

const log = createDebug('soat:oauth');

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret';
const PORT = process.env.PORT ?? '5047';
const ISSUER = process.env.SOAT_PUBLIC_URL ?? `http://localhost:${PORT}`;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
const CONSENT_SESSION_TTL_MS = 10 * 60 * 1000; // 10min

/** Synthetic scope prefix used to carry the granted project through the flow. */
export const PROJECT_SCOPE_PREFIX = 'prj:';

/** Stores a consent grant keyed by PKCE code_challenge (single-use, 10-min TTL). */
export const saveConsentGrant = async (args: {
  codeChallenge: string;
  subject: string;
  scopes: string[];
}): Promise<void> => {
  await db.OauthConsentGrant.upsert({
    codeChallenge: args.codeChallenge,
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
      clientData: client as Record<string, unknown>,
    });
  },
};

// Postgres-backed auth code store (replaces createMemoryAuthCodeStore)
const authCodeStore: AuthCodeStore = {
  save: async (code: StoredAuthorizationCode): Promise<void> => {
    await db.OauthAuthCode.create({
      code: code.code,
      codeData: code as unknown as Record<string, unknown>,
      expiresAt: new Date(code.expiresAt),
    });
  },
  get: async (code: string): Promise<StoredAuthorizationCode | undefined> => {
    const row = await db.OauthAuthCode.findOne({
      where: { code, expiresAt: { [Op.gt]: new Date() } },
    });
    return row
      ? (row.codeData as unknown as StoredAuthorizationCode)
      : undefined;
  },
  delete: async (code: string): Promise<void> => {
    await db.OauthAuthCode.destroy({ where: { code } });
  },
};

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
  issueTokens: ({ subject, scopes }) => {
    const project = scopes
      .find((s) => {
        return s.startsWith(PROJECT_SCOPE_PREFIX);
      })
      ?.slice(PROJECT_SCOPE_PREFIX.length);
    log(
      'issueTokens: subject=%s project=%s scopes=%d',
      subject,
      project,
      scopes.length
    );
    return {
      accessToken: signJwt({
        payload: { sub: subject, scope: scopes.join(' '), prj: project },
        secret: JWT_SECRET,
        expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      }),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  },
  onAuthorize: async ({ request }) => {
    const grant = await db.OauthConsentGrant.findOne({
      where: {
        codeChallenge: request.codeChallenge,
        expiresAt: { [Op.gt]: new Date() },
      },
    });

    if (grant) {
      log('onAuthorize: approved subject=%s', grant.subject);
      await db.OauthConsentGrant.destroy({
        where: { codeChallenge: request.codeChallenge },
      });
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
