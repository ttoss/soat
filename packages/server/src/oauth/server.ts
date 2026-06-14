/**
 * OAuth 2.1 Authorization Server for SOAT, built on `@ttoss/http-server-auth`
 * and `@ttoss/auth-core`. SOAT issues its own first-party tokens so MCP clients
 * (Claude, Cursor, VS Code) can discover, register, and run the full
 * authorize/PKCE flow against this server.
 *
 * ttoss owns the protocol mechanics (discovery, DCR, PKCE, token grants); SOAT
 * owns the three hooks below — token minting, consent, and refresh validation —
 * plus the consent screen itself (see `consentPage.ts`).
 */
import {
  createMemoryAuthCodeStore,
  createMemoryClientStore,
  signJwt,
  verifyJwt,
} from '@ttoss/auth-core';
import { oauthServer } from '@ttoss/http-server-auth';
import createDebug from 'debug';

const log = createDebug('soat:oauth');

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret';
const PORT = process.env.PORT ?? '5047';
const ISSUER = process.env.SOAT_PUBLIC_URL ?? `http://localhost:${PORT}`;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
const CONSENT_SESSION_TTL_MS = 10 * 60 * 1000; // 10min

export const CONSENT_COOKIE = 'soat_consent';
/** Synthetic scope prefix used to carry the granted project through the flow. */
export const PROJECT_SCOPE_PREFIX = 'prj:';

const clientStore = createMemoryClientStore();
const authCodeStore = createMemoryAuthCodeStore();

type ConsentGrant = {
  subject: string;
  scopes: string[];
  expiresAt: number;
};

const consentSessions = new Map<string, ConsentGrant>();

/** Stores an approved consent grant and returns its opaque session id. */
export const putConsentSession = (args: {
  id: string;
  subject: string;
  scopes: string[];
}): void => {
  consentSessions.set(args.id, {
    subject: args.subject,
    scopes: args.scopes,
    expiresAt: Date.now() + CONSENT_SESSION_TTL_MS,
  });
};

/** Reads an unexpired consent grant, deleting it on read (single use). */
export const takeConsentSession = (id: string): ConsentGrant | undefined => {
  const grant = consentSessions.get(id);
  if (!grant) return undefined;
  consentSessions.delete(id);
  if (grant.expiresAt < Date.now()) return undefined;
  return grant;
};

const buildConsentRedirect = (request: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}): string => {
  const params = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: 'code',
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    scope: request.scopes.join(' '),
  });
  if (request.state) params.set('state', request.state);
  return `/oauth/consent?${params.toString()}`;
};

const parseCookie = (
  header: string | undefined,
  name: string
): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
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
  onAuthorize: ({ request, headers }) => {
    const consentId = parseCookie(headers.cookie, CONSENT_COOKIE);
    const grant = consentId ? takeConsentSession(consentId) : undefined;

    if (grant) {
      log('onAuthorize: approved subject=%s', grant.subject);
      return { approved: true, subject: grant.subject, scopes: grant.scopes };
    }

    log('onAuthorize: no consent — redirecting to consent screen');
    return { approved: false, redirect: buildConsentRedirect(request) };
  },
});

/** Verifies a SOAT-issued OAuth access token. Returns the payload or null. */
export const verifyOauthAccessToken = (token: string) => {
  return verifyJwt({ token, secret: JWT_SECRET });
};
