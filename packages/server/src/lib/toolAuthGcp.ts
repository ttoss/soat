import createDebug from 'debug';
import jwt from 'jsonwebtoken';

import { isPlainObject } from './plainObject';
import {
  asString,
  type GcpServiceAccountAuthConfig,
  toolAuthFailed as authFailed,
} from './toolAuthConfig';

const log = createDebug('soat:toolAuth');

const DEFAULT_GCP_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const GCP_TOKEN_LIFETIME_SECONDS = 3600;
// Refresh a minute early so a token cannot expire in flight between the cache
// read and the upstream request.
const GCP_TOKEN_SKEW_SECONDS = 60;

type CachedGcpToken = { accessToken: string; expiresAtMs: number };

// Keyed by service account + token endpoint + scope set, so two tools sharing
// one service account share its token while a different scope set gets its own.
const gcpTokenCache = new Map<string, CachedGcpToken>();

const parseServiceAccount = (credentials: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentials);
  } catch {
    throw authFailed({
      message:
        'execute.auth.credentials is not valid service account JSON. Provide the full service account key file contents (typically via a {{secret:...}} reference).',
    });
  }

  if (!isPlainObject(parsed)) {
    throw authFailed({
      message:
        'execute.auth.credentials must be a service account JSON object.',
    });
  }

  const clientEmail = asString(parsed.client_email);
  const privateKey = asString(parsed.private_key);

  if (!clientEmail || !privateKey) {
    throw authFailed({
      message:
        'execute.auth.credentials is missing client_email or private_key.',
    });
  }

  return {
    clientEmail,
    privateKey,
    tokenUri: asString(parsed.token_uri) ?? DEFAULT_GCP_TOKEN_URI,
  };
};

/**
 * The RFC 7523 JWT-bearer assertion the token endpoint exchanges for an access
 * token. `jsonwebtoken` — already this package's JWT signer — builds and signs
 * it; the base64url encoding, the `{alg, typ}` header and the `crypto.sign`
 * call used to be written out by hand here for a result byte-for-byte the
 * same.
 *
 * `iat` and `exp` are passed explicitly rather than left to the library's
 * `expiresIn`, because the caller injects `now`: the token cache is asserted
 * across a simulated hour, which a wall-clock timestamp could not express.
 *
 * Note this is deliberately *not* `google-auth-library`'s `JWT` client, even
 * though that dependency is present. Its token URL is a module constant used
 * as both the POST target and the assertion's `aud`, with no override, so it
 * cannot honour the `token_uri` a service-account key file names.
 */
const buildAssertion = (args: {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  scopes: string[];
  nowSeconds: number;
}): string => {
  try {
    return jwt.sign(
      {
        iss: args.clientEmail,
        scope: args.scopes.join(' '),
        aud: args.tokenUri,
        iat: args.nowSeconds,
        exp: args.nowSeconds + GCP_TOKEN_LIFETIME_SECONDS,
      },
      args.privateKey,
      { algorithm: 'RS256' }
    );
  } catch (error) {
    throw authFailed({
      message: `Failed to sign the service account assertion: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

const exchangeAssertionForToken = async (args: {
  tokenUri: string;
  assertion: string;
}): Promise<{ accessToken: string; expiresInSeconds: number }> => {
  const response = await fetch(args.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: args.assertion,
    }).toString(),
  });

  const text = await response.text();

  if (!response.ok) {
    throw authFailed({
      message: `The GCP token endpoint rejected the service account assertion (HTTP ${response.status}).`,
      meta: { upstream_status: response.status, upstream_body: text },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw authFailed({
      message: 'The GCP token endpoint returned a non-JSON response.',
      meta: { upstream_status: response.status, upstream_body: text },
    });
  }

  const accessToken = isPlainObject(parsed)
    ? asString(parsed.access_token)
    : undefined;

  if (!accessToken) {
    throw authFailed({
      message: 'The GCP token endpoint response contained no access_token.',
      meta: { upstream_status: response.status },
    });
  }

  const expiresIn =
    isPlainObject(parsed) && typeof parsed.expires_in === 'number'
      ? parsed.expires_in
      : GCP_TOKEN_LIFETIME_SECONDS;

  return { accessToken, expiresInSeconds: expiresIn };
};

export const getGcpAccessToken = async (args: {
  auth: GcpServiceAccountAuthConfig;
  now: Date;
}): Promise<string> => {
  const { clientEmail, privateKey, tokenUri } = parseServiceAccount(
    args.auth.credentials
  );
  const cacheKey = `${clientEmail}|${tokenUri}|${args.auth.scopes.join(' ')}`;
  const cached = gcpTokenCache.get(cacheKey);

  if (cached && cached.expiresAtMs > args.now.getTime()) {
    log('getGcpAccessToken: cache hit clientEmail=%s', clientEmail);
    return cached.accessToken;
  }

  const nowSeconds = Math.floor(args.now.getTime() / 1000);
  const { accessToken, expiresInSeconds } = await exchangeAssertionForToken({
    tokenUri,
    assertion: buildAssertion({
      clientEmail,
      privateKey,
      tokenUri,
      scopes: args.auth.scopes,
      nowSeconds,
    }),
  });

  gcpTokenCache.set(cacheKey, {
    accessToken,
    expiresAtMs:
      args.now.getTime() +
      Math.max(expiresInSeconds - GCP_TOKEN_SKEW_SECONDS, 0) * 1000,
  });

  log('getGcpAccessToken: minted clientEmail=%s', clientEmail);

  return accessToken;
};
